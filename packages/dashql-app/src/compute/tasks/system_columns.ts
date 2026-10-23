import * as arrow from 'apache-arrow';

import { DataFrame, generateTableName } from '../data_frame.js';
import { TableAggregation, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, ColumnGroup, SKIPPED_COLUMN, SystemColumnComputationTask, ROWNUMBER_COLUMN } from '../computation_types.js';
import { LoggableException, LoggerLike, stringifyError } from '../../platform/logger/logger.js';
import { SQLFrame } from '../sql/sqlframe_builder.js';
import { ComputeQueryExecution, executeDirectly } from '../computation_tasks.js';
import { getToNumericFn, isIntegerType, createUniqueColumnName } from '../arrow_columns.js';

const LOG_CTX = "compute";

export async function computeSystemColumns(task: SystemColumnComputationTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<[arrow.Table, DataFrame, ColumnGroup[]]> {
    try {
        const [sqlFrame, columnGroups] = buildSystemColumnSQLFrame(task.inputTable.schema, task.columnEntries, task.inputDataFrame.tableName, task.tableAggregate);

        logger.info("Computing system columns", {
            "version": task.tableVersion.toString(),
        }, LOG_CTX);
        const transformStart = performance.now();
        const tableName = generateTableName("__syscols");
        const sql = sqlFrame.toSQL();
        const transformed = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const transformEnd = performance.now();
        const transformedTable = await transformed.readTable();
        logger.info("Computed system columns", {
            "version": task.tableVersion.toString(),
            "duration": Math.floor(transformEnd - transformStart).toString(),
            "sql": sql,
        }, LOG_CTX);

        let rowNumColumnName: string | null = null;
        for (let i = 0; i < columnGroups.length; ++i) {
            const group = columnGroups[i];
            switch (group.type) {
                case ROWNUMBER_COLUMN:
                    rowNumColumnName = group.value.rowNumberFieldName;
                    break;
            }
        }
        if (!rowNumColumnName) {
            throw new LoggableException("Missing rownum column group", {}, LOG_CTX);
        }
        return [transformedTable, transformed, columnGroups];

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException("Failed to precompute column", { "error": stringifyError(error) }, LOG_CTX);
        }
    }
}

function buildSystemColumnSQLFrame(schema: arrow.Schema, columns: ColumnGroup[], inputTableName: string, tableAggregate: TableAggregation): [SQLFrame, ColumnGroup[]] {
    let fieldNames = new Set<string>();
    for (const field of schema.fields) {
        fieldNames.add(field.name);
    }

    const rowNumberFieldName = createUniqueColumnName(`_rownum`, fieldNames);
    const rowNumberGridColumn: ColumnGroup = {
        type: ROWNUMBER_COLUMN,
        value: {
            rowNumberFieldName: rowNumberFieldName
        }
    };
    let gridColumns: ColumnGroup[] = [
        rowNumberGridColumn,
        ...columns
    ];

    let frame = SQLFrame.from(inputTableName)
        .rowNumber(rowNumberFieldName);

    for (let i = 1; i <= columns.length; ++i) {
        let column = gridColumns[i];
        switch (column.type) {
            case ROWNUMBER_COLUMN:
            case SKIPPED_COLUMN:
                break;
            case ORDINAL_COLUMN: {
                const binFieldName = createUniqueColumnName(`_${i}_bin`, fieldNames);
                frame = frame.binning({
                    fieldName: column.value.inputFieldName,
                    statsTable: tableAggregate.dataFrame.tableName,
                    statsMinField: column.value.statsFields!.minAggregateFieldName!,
                    statsMaxField: column.value.statsFields!.maxAggregateFieldName!,
                    binCount: column.value.binCount,
                    minBinWidth: isIntegerType(column.value.inputFieldType.typeId) ? 1 : undefined,
                    outputAlias: binFieldName,
                    toNumericFn: getToNumericFn(column.value.inputFieldType.typeId),
                });
                gridColumns[i] = {
                    type: ORDINAL_COLUMN,
                    value: {
                        ...column.value,
                        binFieldName: binFieldName,
                    }
                };
                break;
            }
            case STRING_COLUMN: {
                const valueFieldName = createUniqueColumnName(`_${i}_id`, fieldNames);
                frame = frame.valueIdentifier(column.value.inputFieldName, valueFieldName);
                gridColumns[i] = {
                    type: STRING_COLUMN,
                    value: {
                        ...column.value,
                        valueIdFieldName: valueFieldName
                    }
                };
                break;
            }
            case LIST_COLUMN:
                // No value identifier for LIST columns: a dense_rank() over float32
                // embedding arrays sorts the whole table by full-vector comparison at
                // high cost, and nothing consumes the id (no summary is rendered).
                // Leaving valueIdFieldName null; the layout guards on `!= null`.
                break;
        }
    }

    frame = frame.orderBy([{ field: rowNumberFieldName, ascending: true }]);

    return [frame, gridColumns];
}
