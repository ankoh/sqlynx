import * as sqlynx from '@ankoh/sqlynx-core';

import { QueryExecutor } from '../query_executor.js';
import { QueryExecutionArgs } from '../query_execution_args.js';

export async function updateTrinoCatalog(connectionId: number, _catalog: sqlynx.SQLynxCatalog, executor: QueryExecutor): Promise<void> {
    const args: QueryExecutionArgs = {
        query: "select * from information_schema.tables"
    };
    const [_queryId, queryExecution] = executor(connectionId, args);
    const queryResult = await queryExecution;

    console.log(queryResult);

    // XXX Update the catalog
}
