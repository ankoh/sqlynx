import { DataFrame, generateTableName } from '../data_frame.js';
import { TableOrderingTask, OrderingTable } from '../computation_types.js';
import { LoggableException, LoggerLike, stringifyError } from '../../platform/logger/logger.js';
import { SQLFrame } from '../sql/sqlframe_builder.js';
import { ComputeQueryExecution, executeDirectly } from '../computation_tasks.js';

const LOG_CTX = "compute";

export async function sortTable(task: TableOrderingTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<OrderingTable> {
    if (task.orderingConstraints.length == 1) {
        logger.info("Sorting table by field", {
            "field": task.orderingConstraints[0].field
        }, LOG_CTX);
    } else {
        logger.info("Sorting table by multiple fields", {}, LOG_CTX);
    }

    try {
        let frame = SQLFrame.from(task.inputDataFrame.tableName);
        if (task.filterTable != null) {
            frame = frame.semiJoinFilter(
                task.rowNumberColumnName,
                task.filterTable.dataFrame.tableName,
                task.filterTable.dataTable.schema.fields[0].name,
            );
        }
        if (task.dataSearchTable != null) {
            frame = frame.semiJoinFilter(
                task.rowNumberColumnName,
                task.dataSearchTable.dataFrame.tableName,
                task.dataSearchTable.dataTable.schema.fields[0].name,
            );
        }
        const sql = frame
            .orderBy(task.orderingConstraints)
            .project([task.rowNumberColumnName])
            .toSQL();

        const sortStart = performance.now();
        const tableName = generateTableName("__ordered");
        const transformed = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const sortEnd = performance.now();
        const orderedTable = await transformed.readTable();
        logger.info("Sorted table", {
            "version": task.tableVersion.toString(),
            "duration": Math.floor(sortEnd - sortStart).toString(),
            "inputRows": task.inputDataTable.numRows.toString(),
            "outputRows": orderedTable.numRows.toString(),
        }, LOG_CTX);
        const out: OrderingTable = {
            inputRowNumberColumnName: task.rowNumberColumnName,
            orderingConstraints: task.orderingConstraints,
            dataTable: orderedTable,
            dataFrame: transformed,
            // Ordering depends on filtered data, so version stays same
            version: task.tableVersion,
            dataSearchRequestId: task.dataSearchTable?.requestId ?? null,
        };
        return out;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException(`Sorting table failed`, { "error": stringifyError(error) }, LOG_CTX);
        }
    }
}
