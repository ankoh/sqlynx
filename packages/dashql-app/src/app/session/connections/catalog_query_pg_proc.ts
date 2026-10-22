import * as arrow from "apache-arrow";

import { QueryExecutor } from './query_executor.js';
import { QueryExecutionArgs } from './query_execution_args.js';
import { DynamicAttachedDatabaseDispatch } from './attached_database_registry.js';
import { CATALOG_UPDATE_REGISTER_QUERY } from "./attached_database_state.js";
import { QueryType } from './query_execution_state.js';
import { type FunctionMetadata, generateFunctionsSQL } from './catalog_function_sql_generator.js';
import { quoteIdentifier } from './catalog_sql_generator.js';
import type { LoggerLike } from '../../../platform/logger/logger.js';

const CATALOG_QUERY_READ_TIMEOUT_MS = 60_000;

export type PgProcTable = arrow.Table<{
    function_schema: arrow.Utf8;
    function_name: arrow.Utf8;
    argument_types: arrow.List<arrow.Utf8>;
    argument_names: arrow.List<arrow.Utf8>;
    argument_modes: arrow.List<arrow.Utf8>;
    return_type: arrow.Utf8;
    returns_set: arrow.Bool;
    function_kind: arrow.Utf8;
}>;

export function generateCatalogSQLFromPgProc(result: PgProcTable, databaseName: string | null | undefined, logger?: LoggerLike): string {
    const functions: FunctionMetadata[] = [];

    for (const batch of result.batches) {
        const colSchema = batch.getChild("function_schema")!;
        const colName = batch.getChild("function_name")!;
        const colTypes = batch.getChild('argument_types')!;
        const colNames = batch.getChild('argument_names')!;
        const colModes = batch.getChild('argument_modes')!;
        const colReturnsSet = batch.getChild('returns_set')!;
        const colReturn = batch.getChild("return_type")!;
        const colKind = batch.getChild("function_kind")!;

        for (let i = 0; i < batch.numRows; ++i) {
            const schemaName = colSchema.at(i);
            const functionName = colName.at(i);
            const returnType = colReturn.at(i);
            const kind = colKind.at(i);

            if (!functionName) {
                continue;
            }
            const types = Array.from(colTypes.at(i) ?? []);
            const names = Array.from(colNames.at(i) ?? []);
            const modes = Array.from(colModes.at(i) ?? []);
            if (!types.every(type => typeof type === 'string')
                || !names.every(name => name == null || typeof name === 'string')
                || !modes.every(mode => typeof mode === 'string')
                || (names.length !== 0 && names.length !== types.length)
                || (modes.length !== 0 && modes.length !== types.length)) {
                throw new Error('pg_proc returned invalid function argument metadata');
            }
            // DashQL declarations model scalar signatures only. Qualified custom types and
            // set/table results are not in its type grammar; do not let one poison the batch.
            const unsupportedType = (type: string) => type.replace(/"(?:[^"]|"")*"/g, '').includes('.');
            if (colReturnsSet.at(i) || modes.includes('t') || !returnType
                || unsupportedType(returnType) || types.some(unsupportedType)
                || modes.some(mode => !['i', 'o', 'b', 'v', 't'].includes(mode))) {
                logger?.warn('Skipping unsupported PostgreSQL function signature', {
                    schema: schemaName, function: functionName, returnType,
                }, 'catalog_pg');
                continue;
            }
            const args = types.flatMap((type, index) => modes[index] === 'o' ? [] : [
                `${quoteIdentifier(names[index] || `arg${index + 1}`)} ${type}`,
            ]).join(', ');
            functions.push({
                schemaName,
                functionName,
                arguments: args,
                returnType,
                isAggregate: kind === 'a',
            });
        }
    }

    return generateFunctionsSQL(databaseName, functions);
}

export async function queryPgProc(
    connectionId: string,
    connectionDispatch: DynamicAttachedDatabaseDispatch,
    updateId: number,
    executor: QueryExecutor,
    abortSignal?: AbortSignal,
): Promise<PgProcTable | null> {
    const query = `
        SELECT
            n.nspname AS function_schema,
            p.proname AS function_name,
            -- Hyper cannot cast oidvector to oid[]; format each source separately.
            CASE WHEN p.proallargtypes IS NOT NULL THEN ARRAY(
                SELECT pg_catalog.format_type(arg.type_oid, NULL)
                FROM unnest(p.proallargtypes) WITH ORDINALITY AS arg(type_oid, position)
                ORDER BY arg.position
            ) ELSE ARRAY(
                SELECT pg_catalog.format_type(arg.type_oid, NULL)
                FROM unnest(p.proargtypes) WITH ORDINALITY AS arg(type_oid, position)
                ORDER BY arg.position
            ) END AS argument_types,
            p.proargnames AS argument_names,
            p.proargmodes AS argument_modes,
            COALESCE(pg_catalog.format_type(p.prorettype, NULL), 'any') AS return_type,
            p.proretset AS returns_set,
            p.prokind AS function_kind
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'a', 'w', 'p')
        ORDER BY n.nspname, p.proname
    `;

    const args: QueryExecutionArgs = {
        query: query,
        abortSignal,
        readTimeoutMs: CATALOG_QUERY_READ_TIMEOUT_MS,
        throwOnError: true,
        metadata: {
            queryType: QueryType.CATALOG_QUERY_PG_PROC,
            title: "Query Postgres Functions",
            description: null,
            issuer: "Catalog Update",
            userProvided: false
        }
    };
    const [queryId, queryExecution] = executor(connectionId, args);
    connectionDispatch(connectionId, {
        type: CATALOG_UPDATE_REGISTER_QUERY,
        value: [updateId, queryId]
    });

    const queryResult = await queryExecution as PgProcTable;
    return queryResult;
}
