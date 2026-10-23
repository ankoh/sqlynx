import { DataFrame, generateTableName } from '../data_frame.js';
import { DataSearchTask, DataSearchTable } from '../computation_types.js';
import { LoggableException, LoggerLike, stringifyError } from '../../platform/logger/logger.js';
import { buildDataSearchSQL } from '../sql/query_result_search_sql.js';
import { ComputeQueryExecution, executeDirectly } from '../computation_tasks.js';

const LOG_CTX = "compute";

export async function searchData(
    task: DataSearchTask,
    logger: LoggerLike,
    executeQuery: ComputeQueryExecution = executeDirectly,
): Promise<DataSearchTable> {
    const sql = buildDataSearchSQL(
        task.inputDataFrame.tableName,
        task.rowNumberColumnName,
        task.columns,
        task.pattern,
    );
    try {
        logger.info('Searching table data', {
            version: task.tableVersion.toString(),
            requestId: task.requestId.toString(),
        }, LOG_CTX);
        const tableName = generateTableName('__search');
        const dataFrame = await executeQuery(sql, () => DataFrame.fromSQL(
            task.inputDataFrame.database,
            sql,
            tableName,
            task.abortController.signal,
        ));
        try {
            const dataTable = await dataFrame.readTable(task.abortController.signal);
            return {
                inputRowNumberColumnName: task.rowNumberColumnName,
                dataTable,
                dataFrame,
                version: task.tableVersion,
                requestId: task.requestId,
            };
        } catch (error) {
            await dataFrame.destroy();
            throw error;
        }
    } catch (error) {
        if (error instanceof LoggableException) throw error;
        throw new LoggableException('Failed to search table data', { error: stringifyError(error) }, LOG_CTX);
    }
}
