import { DataFrame, generateTableName } from '../data_frame.js';
import { TableFilteringTask, FilterTable } from '../computation_types.js';
import { LoggableException, LoggerLike, stringifyError } from '../../platform/logger/logger.js';
import { SQLFrame } from '../sql/sqlframe_builder.js';
import { ComputeQueryExecution, executeDirectly } from '../computation_tasks.js';

const LOG_CTX = "compute";

export async function filterTable(task: TableFilteringTask, logger: LoggerLike, executeQuery: ComputeQueryExecution = executeDirectly): Promise<FilterTable | null> {
    if (task.filters.length == 0) {
        return null;
    }

    try {
        let frame = SQLFrame.from(task.inputDataFrame.tableName);
        for (const f of task.filters) {
            frame = frame.filter(f.fieldName, f.op, f.value);
        }
        frame = frame.project([task.rowNumberColumnName]);
        const sql = frame.toSQL();

        logger.info("Filtering table", {
            "version": task.tableVersion.toString(),
        }, LOG_CTX);
        const filterStart = performance.now();
        const tableName = generateTableName("__filter");
        const transformed = await executeQuery(sql, () => DataFrame.fromSQL(task.inputDataFrame.database, sql, tableName));
        const filterEnd = performance.now();
        const filterResultTable = await transformed.readTable();

        logger.info("Filtered table", {
            "version": task.tableVersion.toString(),
            "duration": Math.floor(filterEnd - filterStart).toString(),
            "inputRows": task.inputDataTable.numRows.toString(),
            "outputRows": filterResultTable.numRows.toString(),
            "sql": sql,
        }, LOG_CTX);

        const out: FilterTable = {
            inputRowNumberColumnName: task.rowNumberColumnName,
            dataTable: filterResultTable,
            dataFrame: transformed,
            // Version is already the target - state was incremented when task was scheduled
            version: task.tableVersion,
        };
        return out;

    } catch (error: any) {
        if (error instanceof LoggableException) {
            throw error;
        } else {
            throw new LoggableException(`Failed to filter table`, { "error": stringifyError(error) }, LOG_CTX);
        }
    }
}
