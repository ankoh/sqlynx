import * as arrow from "apache-arrow";
import * as dashql from '@ankoh/dashql-core';

import { QueryExecutor } from './query_executor.js';
import { QueryExecutionArgs } from './query_execution_args.js';
import { DynamicConnectionDispatch } from './connection_registry.js';
import { CATALOG_UPDATE_SCHEMA_SCRIPT, CATALOG_UPDATE_REGISTER_QUERY } from "./connection_state.js";
import { QueryType } from './query_execution_state.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from "./catalog_update_state.js";
import { generateSchemaSQL, generateCatalogScriptHeader, CatalogSource, quoteIdentifier, type ColumnMetadata } from './catalog_sql_generator.js';
import { generateFunctionScriptHeader } from './catalog_function_sql_generator.js';
import { queryPgProc, generateCatalogSQLFromPgProc } from './catalog_query_pg_proc.js';
import { type LoggerLike } from '../../platform/logger/logger.js';
import { beginCatalogBatch, publishCatalogBatch, type CatalogBatchEntry, type CatalogBatchOptions } from './catalog_batch.js';

const LOG_CTX = "catalog_pg";
export const CATALOG_QUERY_READ_TIMEOUT_MS = 60_000;

export type PgAttributeColumnsTable = arrow.Table<{
    table_schema: arrow.Utf8;
    table_name: arrow.Utf8;
    column_name: arrow.Utf8;
    ordinal_position: arrow.Int32;
    data_type: arrow.Utf8;
    is_nullable: arrow.Utf8;
    numeric_precision: arrow.Int32;
    numeric_scale: arrow.Int32;
}>;

/**
 * Generates SQL DDL from pg_attribute query results.
 * Builds a hierarchy of schema -> table -> columns and generates CREATE TABLE statements.
 */
export function generateCatalogSQLFromPgAttribute(result: PgAttributeColumnsTable, databaseName: string): string {
    // Build hierarchy: schema -> table -> columns
    const schemas = new Map<string, Map<string, ColumnMetadata[]>>();

    for (const batch of result.batches) {
        const colTableSchema = batch.getChild("table_schema")!;
        const colTableName = batch.getChild("table_name")!;
        const colColumnName = batch.getChild("column_name")!;
        const colOrdinalPos = batch.getChild("ordinal_position")!;
        const colDataType = batch.getChild("data_type")!;

        // Iterate over all rows in the batch
        for (let i = 0; i < batch.numRows; ++i) {
            const tableSchema = colTableSchema.at(i);
            const tableName = colTableName.at(i);
            const columnName = colColumnName.at(i);
            const ordinalPosition = colOrdinalPos.at(i);
            const dataType = colDataType.at(i);

            if (!tableSchema || !columnName || !tableName) {
                continue;
            }

            // Get or create schema entry
            let tableMap = schemas.get(tableSchema);
            if (!tableMap) {
                tableMap = new Map<string, ColumnMetadata[]>();
                schemas.set(tableSchema, tableMap);
            }

            // Get or create table entry
            let columns = tableMap.get(tableName);
            if (!columns) {
                columns = [];
                tableMap.set(tableName, columns);
            }

            // Add column metadata
            columns.push({
                name: columnName,
                ordinalPosition: ordinalPosition ?? columns.length,
                dataType: dataType ?? null,
            });
        }
    }

    // Generate SQL for all schemas
    const sqlStatements: string[] = [];
    for (const [schemaName, schemaTables] of schemas) {
        const sql = generateSchemaSQL(databaseName, schemaName, schemaTables);
        if (sql.length > 0) {
            sqlStatements.push(sql);
        }
    }

    return sqlStatements.join('\n\n');
}

export async function queryPgAttribute(
    connectionId: string,
    connectionDispatch: DynamicConnectionDispatch,
    updateId: number,
    databaseName: string,
    schemaNames: string[],
    executor: QueryExecutor,
    queryDatabaseName: string | null = null,
    abortSignal?: AbortSignal,
): Promise<PgAttributeColumnsTable | null> {
    const pgCatalog = queryDatabaseName == null
        ? 'pg_catalog'
        : `${quoteIdentifier(queryDatabaseName)}.${quoteIdentifier('pg_catalog')}`;
    const schemaFilter = schemaNames.length > 0
        ? `AND n.nspname IN (${schemaNames.map(name => `'${name.replace(/'/g, "''")}'`).join(', ')})`
        : '';
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
        FROM ${pgCatalog}.pg_class c
        JOIN ${pgCatalog}.pg_namespace n ON n.oid = c.relnamespace
        JOIN ${pgCatalog}.pg_attribute a ON a.attrelid = c.oid
        JOIN ${pgCatalog}.pg_type t ON t.oid = a.atttypid
        LEFT JOIN ${pgCatalog}.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.relkind IN ('r', 'v', 'm', 'f', 'p')
          AND a.attnum > 0
          AND NOT a.attisdropped
        ${schemaFilter}
        ORDER BY n.nspname, c.relname, a.attnum
    `;

    const args: QueryExecutionArgs = {
        query: query,
        abortSignal,
        readTimeoutMs: CATALOG_QUERY_READ_TIMEOUT_MS,
        throwOnError: true,
        metadata: {
            queryType: QueryType.CATALOG_QUERY_PG_ATTRIBUTE,
            title: "Query Postgres Schema Columns",
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

    const queryResult = await queryExecution as PgAttributeColumnsTable;
    return queryResult;
}

export async function updatePgSchemaScript(
    logger: LoggerLike,
    connectionId: string,
    connectionDispatch: DynamicConnectionDispatch,
    updateId: number,
    databaseName: string,
    schemaNames: string[],
    executor: QueryExecutor,
    catalog: dashql.DashQLCatalog,
    catalogRelationScript: dashql.DashQLScript,
    options: CatalogBatchOptions = {},
): Promise<void> {
    const validate = beginCatalogBatch(catalog, options);
    const queryResult = await queryPgAttribute(connectionId, connectionDispatch, updateId, databaseName, schemaNames, executor, null, options.abortSignal);
    validate();
    if (queryResult == null || queryResult.numRows === 0) {
        throw new Error('pg_attribute returned no catalog relations');
    }

    const header = generateCatalogScriptHeader(CatalogSource.PgClass);
    const catalogSQL = generateCatalogSQLFromPgAttribute(queryResult, databaseName);
    if (catalogSQL.length === 0) {
        throw new Error('pg_attribute returned no usable catalog relations');
    }

    connectionDispatch(connectionId, {
        type: CATALOG_UPDATE_SCHEMA_SCRIPT,
        value: [updateId]
    });

    const [relations] = await publishCatalogBatch(catalogRelationScript.ptr.api, catalog, [{
        script: catalogRelationScript, text: `${header}${catalogSQL}`, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK,
    }], options, validate);
    logger.info("Collected tables from pg_attribute", {
        "updateId": updateId.toString(),
        "tables": relations.tables.toString(),
    }, LOG_CTX);
}

export async function updatePgCatalog(
    logger: LoggerLike,
    connectionId: string,
    connectionDispatch: DynamicConnectionDispatch,
    updateId: number,
    databaseName: string,
    schemaNames: string[],
    executor: QueryExecutor,
    catalog: dashql.DashQLCatalog,
    dql: dashql.DashQL,
    catalogRelationScript: dashql.DashQLScript,
    catalogFunctionScript: dashql.DashQLScript,
    options: CatalogBatchOptions = {},
): Promise<void> {
    const validate = beginCatalogBatch(catalog, options);
    const [relationsResult, functionsResult] = await Promise.all([
        queryPgAttribute(connectionId, connectionDispatch, updateId, databaseName, schemaNames, executor, null, options.abortSignal),
        queryPgProc(connectionId, connectionDispatch, updateId, executor, options.abortSignal),
    ]);
    validate();
    if (relationsResult == null || relationsResult.numRows === 0) {
        throw new Error('pg_attribute returned no catalog relations');
    }
    const relationsSQL = generateCatalogSQLFromPgAttribute(relationsResult, databaseName);
    if (!relationsSQL) throw new Error('pg_attribute returned no usable catalog relations');
    const entries: CatalogBatchEntry[] = [{
        script: catalogRelationScript,
        text: `${generateCatalogScriptHeader(CatalogSource.PgClass)}${relationsSQL}`,
        rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK,
    }];
    if (functionsResult == null) throw new Error('pg_proc returned no function metadata result');
    entries.push({
        script: catalogFunctionScript,
        text: `${generateFunctionScriptHeader(CatalogSource.PgClass)}${generateCatalogSQLFromPgProc(functionsResult, databaseName, logger)}`,
        rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK,
    });
    connectionDispatch(connectionId, { type: CATALOG_UPDATE_SCHEMA_SCRIPT, value: [updateId] });
    const counts = await publishCatalogBatch(dql, catalog, entries, options, validate);
    logger.info('Collected PostgreSQL catalog', {
        updateId: updateId.toString(),
        tables: counts[0].tables.toString(),
        functions: counts[1].functions.toString(),
    }, LOG_CTX);
}
