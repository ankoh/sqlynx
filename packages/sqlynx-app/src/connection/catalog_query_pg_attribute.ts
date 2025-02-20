import * as sqlynx from '@ankoh/sqlynx-core';

import { QueryExecutor } from './query_executor.js';
import { QueryExecutionArgs } from './query_execution_args.js';

export async function queryPgAttribute(connectionId: number, schemaNames: string[], executor: QueryExecutor): Promise<void> {
    const query = `
        SELECT 
            n.nspname AS table_schema,
            c.relname AS table_name,
            a.attname AS column_name,
            a.attnum AS ordinal_position,
            t.typname AS data_type,
            CASE 
                WHEN a.attnotnull THEN 'NO'
                ELSE 'YES'
            END AS is_nullable,
            CASE 
                WHEN a.atttypid = ANY (ARRAY[21, 23, 20]) THEN a.atttypmod - 4
                WHEN a.atttypid = 1700 THEN ((a.atttypmod - 4) >> 16) & 65535
                ELSE NULL
            END AS numeric_precision,
            CASE 
                WHEN a.atttypid = 1700 THEN (a.atttypmod - 4) & 65535
                ELSE NULL
            END AS numeric_scale
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        JOIN pg_type t ON t.oid = a.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        ${schemaNames.length > 0 ? `AND table_schema IN ('${schemaNames.join("','")}')` : ''}
    `

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

export async function updateInformationSchemaCatalog(connectionId: number, schemaNames: string[], executor: QueryExecutor, _catalog: sqlynx.SQLynxCatalog): Promise<void> {
    await queryPgAttribute(connectionId, schemaNames, executor);
}
