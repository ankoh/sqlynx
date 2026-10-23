import { ArrowTableFormatter } from '../arrow_formatter.js';
import { DataFrame, generateTableName } from '../data_frame.js';
import { createArrowFieldIndex } from '../computation_state.js';
import { TableAggregationTask, TableAggregation, ORDINAL_COLUMN, STRING_COLUMN, LIST_COLUMN, ColumnGroup, SKIPPED_COLUMN, ROWNUMBER_COLUMN } from '../computation_types.js';
import { LoggableException, LoggerLike, stringifyError } from '../../platform/logger/logger.js';
import { SQLFrame } from '../sql/sqlframe_builder.js';
import { ComputeQueryExecution, executeDirectly } from '../computation_tasks.js';
import { isIntegerType, getSmallIntegerDomainSize } from '../arrow_columns.js';

const LOG_CTX = "compute";

export async function computeTableAggregates(task: TableAggregationTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<[TableAggregation, ColumnGroup[]]> {
    const [sql, columnEntries, countStarColumn] = buildTableAggregationSQL(task);

    try {
        logger.info("Aggregating table", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
        }, LOG_CTX);
        const summaryStart = performance.now();
        const tableName = generateTableName("__tbl_agg");
        const transformedDataFrame = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const summaryEnd = performance.now();
        logger.info("Aggregated table", {
            "version": task.tableVersion.toString(),
            "table": task.tableId.toString(),
            "duration": Math.floor(summaryEnd - summaryStart).toString()
        }, LOG_CTX);

        const statsTable = await transformedDataFrame.readTable();
        const statsTableFields = createArrowFieldIndex(statsTable);
        const statsTableFormatter = new ArrowTableFormatter(statsTable.schema, statsTable.batches, logger);

        for (let i = 0; i < columnEntries.length; ++i) {
            const entry = columnEntries[i];
            if (entry.type != ORDINAL_COLUMN || !isIntegerType(entry.value.inputFieldType.typeId)) {
                continue;
            }
            const minValue = statsTable.getChild(entry.value.statsFields!.minAggregateFieldName!)?.get(0);
            const maxValue = statsTable.getChild(entry.value.statsFields!.maxAggregateFieldName!)?.get(0);
            const domainSize = getSmallIntegerDomainSize(minValue, maxValue, entry.value.binCount);
            if (domainSize != null) {
                columnEntries[i] = {
                    type: ORDINAL_COLUMN,
                    value: { ...entry.value, binCount: domainSize },
                };
            }
        }

        const summary: TableAggregation = {
            table: statsTable,
            tableFormatter: statsTableFormatter,
            tableFieldsByName: statsTableFields,
            dataFrame: transformedDataFrame,
            countStarFieldName: countStarColumn,
        };
        return [summary, columnEntries];

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException("computing aggregate failed", {
                "table": task.tableId.toString(),
                "error": stringifyError(error)
            }, LOG_CTX);
        }
    }
}

function buildTableAggregationSQL(task: TableAggregationTask): [string, ColumnGroup[], string] {
    const countColumn = `_count`;
    const aggregates: { fieldName?: string; outputAlias: string; func: "min" | "max" | "count" | "count_star"; distinct?: boolean }[] = [];

    aggregates.push({ outputAlias: `_count`, func: "count_star" });

    const updatedEntries: ColumnGroup[] = [];
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
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: countAggregateColumn, func: "count" });
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: minAggregateColumn, func: "min" });
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: maxAggregateColumn, func: "max" });
                updatedEntries.push({
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
                });
                break;
            }
            case STRING_COLUMN: {
                const countAggregateColumn = `_${i}_count`;
                const countDistinctAggregateColumn = `_${i}_countd`;
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: countAggregateColumn, func: "count" });
                aggregates.push({ fieldName: entry.value.inputFieldName, outputAlias: countDistinctAggregateColumn, func: "count", distinct: true });
                updatedEntries.push({
                    type: STRING_COLUMN,
                    value: {
                        ...entry.value,
                        statsFields: {
                            countFieldName: countAggregateColumn,
                            distinctCountFieldName: countDistinctAggregateColumn,
                            minAggregateFieldName: null,
                            maxAggregateFieldName: null,
                        }
                    }
                });
                break;
            }
            case LIST_COLUMN:
                // No table-level aggregates for LIST columns. In particular
                // count(DISTINCT array) over float32 embeddings hashes every full
                // vector at high cost, and no summary consumes it. Leaving
                // statsFields null and passing the entry through unchanged.
                updatedEntries.push(entry);
                break;
        }
    }

    const sql = SQLFrame.from(task.inputDataFrame.tableName)
        .groupBy({
            keys: [],
            aggregates,
        })
        .toSQL();
    return [sql, updatedEntries, countColumn];
}
