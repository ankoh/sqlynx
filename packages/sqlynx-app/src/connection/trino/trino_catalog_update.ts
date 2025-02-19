import * as sqlynx from '@ankoh/sqlynx-core';

import { QueryExecutor } from '../query_executor.js';
import { QueryExecutionArgs } from '../query_execution_args.js';
import { TrinoConnectionDetails } from './trino_connection_state.js';

export async function updateTrinoCatalog(connectionId: number, connDetails: TrinoConnectionDetails, _catalog: sqlynx.SQLynxCatalog, executor: QueryExecutor): Promise<void> {
    // XXX Support multiple schemas
    const query = connDetails.channelParams?.schemaName
        ? `select * from information_schema.tables where table_schema = '${connDetails.channelParams?.schemaName}'`
        : `select * from information_schema.tables`;

    const args: QueryExecutionArgs = {
        query: query
    };
    const [_queryId, queryExecution] = executor(connectionId, args);
    const queryResult = await queryExecution;

    if (queryResult == null) {
        // XXX
        return;
    }

    // XXX Update the catalog
}
