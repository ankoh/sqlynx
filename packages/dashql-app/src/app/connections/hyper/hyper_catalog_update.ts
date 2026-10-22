import * as arrow from 'apache-arrow';
import * as dashql from '@ankoh/dashql-core';

import { CATALOG_UPDATE_SCHEMA_SCRIPT, CATALOG_UPDATE_REGISTER_QUERY } from '../attached_database_state.js';
import { DynamicAttachedDatabaseDispatch } from '../attached_database_registry.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from '../catalog_update_state.js';
import { CatalogSource, DEFAULT_DATABASE_NAME, generateCatalogScriptHeader, generateCatalogScriptHeaderForSource, generateSchemaSQL, quoteIdentifier, type ColumnMetadata } from '../catalog_sql_generator.js';
import { CATALOG_QUERY_READ_TIMEOUT_MS, queryPgAttribute, generateCatalogSQLFromPgAttribute } from '../catalog_query_pg_attribute.js';
import { QueryExecutionArgs } from '../query_execution_args.js';
import { QueryExecutor } from '../query_executor.js';
import { QueryType } from '../query_execution_state.js';
import type { LoggerLike } from '../../../platform/logger/logger.js';
import type { AttachedDatabase } from './hyperdb_grpc_client.js';
import { qualifyPrefetchedHyperFunctions } from '../prefetched_hyper_functions.js';
import { beginCatalogBatch, publishCatalogBatch, type CatalogBatchOptions } from '../catalog_batch.js';
import { generateFunctionScriptHeaderForSource } from '../catalog_function_sql_generator.js';
import { generateCatalogSQLFromPgProc, queryPgProc } from '../catalog_query_pg_proc.js';

const LOG_CTX = 'hyper_catalog';
const SECTION_BEGIN = '-- DashQL Hyper Catalog Section: ';
const SECTION_END = '-- DashQL Hyper Catalog Section End';

export type HyperCloudCatalogTable = arrow.Table<{
    schema_name: arrow.Utf8;
    table_name: arrow.Utf8;
    column_name: arrow.Utf8;
    ordinal_position: arrow.Int32;
    data_type: arrow.Utf8;
}>;

export interface HyperCatalogUpdateFailure {
    database: string;
    error: Error;
}

export interface HyperCatalogUpdateResult {
    updatedDatabases: string[];
    failures: HyperCatalogUpdateFailure[];
}

interface CatalogTarget {
    key: string;
    databaseName: string;
    queryDatabaseName: string | null;
    path: string;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function summarizeFailures(message: string, failures: HyperCatalogUpdateFailure[]): Error {
    return new Error(`${message}: ${failures.map(failure => `${failure.database}: ${failure.error.message}`).join('; ')}`);
}

function buildCatalogTargets(attachedDatabases: AttachedDatabase[]): CatalogTarget[] {
    if (attachedDatabases.length === 0) {
        return [{ key: DEFAULT_DATABASE_NAME, databaseName: DEFAULT_DATABASE_NAME, queryDatabaseName: null, path: '' }];
    }
    return attachedDatabases.map(database => ({
        key: database.alias ?? '',
        databaseName: database.alias ?? '',
        queryDatabaseName: database.alias || null,
        path: database.path,
    }));
}

export function buildHyperCloudCatalogQuery(databaseAlias: string): string {
    const database = quoteIdentifier(databaseAlias);
    const table = (name: string) => `${database}.${quoteIdentifier('_hyper_catalog')}.${quoteIdentifier(name)}`;
    return `
        SELECT
            s.schema_name_display AS schema_name,
            o.object_name_display AS table_name,
            c.column_name_display AS column_name,
            c.ordinal_position AS ordinal_position,
            CAST(c.type_descriptor AS TEXT) AS data_type
        FROM ${table('databases')} d
        JOIN ${table('schemas')} s
          ON s.account_id = d.account_id
         AND s.database_id = d.database_id
        JOIN ${table('objects')} o
          ON o.account_id = s.account_id
         AND o.schema_id = s.schema_id
        JOIN ${table('columns')} c
          ON c.account_id = o.account_id
         AND c.object_id = o.object_id
        WHERE o.object_type IN ('ICEBERG_TABLE', 'VIEW')
        ORDER BY
            s.schema_name_display,
            o.object_name_display,
            c.ordinal_position
    `;
}

export function generateCatalogSQLFromHyperCloud(result: HyperCloudCatalogTable, attachedDatabaseName: string): string {
    const schemas = new Map<string, Map<string, ColumnMetadata[]>>();
    for (const batch of result.batches) {
        const schemaNames = batch.getChild('schema_name')!;
        const tableNames = batch.getChild('table_name')!;
        const columnNames = batch.getChild('column_name')!;
        const ordinalPositions = batch.getChild('ordinal_position')!;
        const dataTypes = batch.getChild('data_type')!;

        for (let i = 0; i < batch.numRows; ++i) {
            const schemaName = schemaNames.at(i);
            const tableName = tableNames.at(i);
            const columnName = columnNames.at(i);
            if (!schemaName || !tableName || !columnName) continue;

            let tables = schemas.get(schemaName);
            if (!tables) schemas.set(schemaName, tables = new Map());
            let columns = tables.get(tableName);
            if (!columns) tables.set(tableName, columns = []);
            columns.push({
                name: columnName,
                ordinalPosition: ordinalPositions.at(i) ?? columns.length,
                dataType: dataTypes.at(i) ?? null,
            });
        }
    }

    const statements: string[] = [];
    for (const schemaName of [...schemas.keys()].sort()) {
        statements.push(generateSchemaSQL(attachedDatabaseName, schemaName, schemas.get(schemaName)!));
    }
    return statements.filter(Boolean).join('\n\n');
}

async function queryHyperCloudCatalog(
    connectionId: string,
    connectionDispatch: DynamicAttachedDatabaseDispatch,
    updateId: number,
    databaseAlias: string,
    executor: QueryExecutor,
    abortSignal: AbortSignal,
): Promise<HyperCloudCatalogTable> {
    const args: QueryExecutionArgs = {
        query: buildHyperCloudCatalogQuery(databaseAlias),
        abortSignal,
        readTimeoutMs: CATALOG_QUERY_READ_TIMEOUT_MS,
        throwOnError: true,
        metadata: {
            queryType: QueryType.CATALOG_QUERY_HYPER_CLOUD,
            title: `Query Hyper Cloud Catalog (${databaseAlias})`,
            description: null,
            issuer: 'Catalog Update',
            userProvided: false,
        },
    };
    const [queryId, queryExecution] = executor(connectionId, args);
    connectionDispatch(connectionId, {
        type: CATALOG_UPDATE_REGISTER_QUERY,
        value: [updateId, queryId],
    });
    const result = await queryExecution as HyperCloudCatalogTable | null;
    if (result == null || result.numRows === 0) {
        throw new Error(`Hyper Cloud catalog for ${databaseAlias} returned no relations`);
    }
    return result;
}

function parseCatalogSections(script: string): Map<string, string> {
    const sections = new Map<string, string>();
    let offset = 0;
    while (true) {
        const begin = script.indexOf(SECTION_BEGIN, offset);
        if (begin < 0) break;
        const keyEnd = script.indexOf('\n', begin);
        if (keyEnd < 0) break;
        const end = script.indexOf(SECTION_END, keyEnd + 1);
        if (end < 0) break;
        try {
            const key = JSON.parse(script.slice(begin + SECTION_BEGIN.length, keyEnd)) as string;
            sections.set(key, script.slice(keyEnd + 1, end).trim());
        } catch {
            // Ignore malformed legacy markers and rebuild the successfully queried sections.
        }
        offset = end + SECTION_END.length;
    }
    return sections;
}

function renderCatalogSections(sections: Map<string, string>, targetOrder: string[], source: string | null): string {
    const rendered = targetOrder
        .filter((key, index) => targetOrder.indexOf(key) === index && sections.has(key))
        .map(key => `${SECTION_BEGIN}${JSON.stringify(key)}\n${sections.get(key)}\n${SECTION_END}`);
    const header = source == null
        ? generateCatalogScriptHeader(CatalogSource.Hyper)
        : generateCatalogScriptHeaderForSource(source);
    return `${header}${rendered.join('\n\n')}\n`;
}

export async function updateHyperCatalog(
    logger: LoggerLike,
    connectionId: string,
    connectionDispatch: DynamicAttachedDatabaseDispatch,
    updateId: number,
    attachedDatabases: AttachedDatabase[],
    executor: QueryExecutor,
    catalog: dashql.DashQLCatalog,
    dql: dashql.DashQL,
    catalogRelationScript: dashql.DashQLScript,
    catalogFunctionScript: dashql.DashQLScript,
    resolveLiveFunctionCatalog: boolean,
    abortSignal: AbortSignal,
    options: CatalogBatchOptions = {},
): Promise<HyperCatalogUpdateResult> {
    options = { ...options, abortSignal };
    const validate = beginCatalogBatch(catalog, options);
    const targets = buildCatalogTargets(attachedDatabases);
    const aliasCounts = new Map<string, number>();
    for (const target of targets) aliasCounts.set(target.key, (aliasCounts.get(target.key) ?? 0) + 1);

    const results = await Promise.all(targets.map(async target => {
        try {
            abortSignal.throwIfAborted();
            if (attachedDatabases.length > 0 && !target.key.trim()) {
                throw new Error('Attached databases require a non-empty alias for catalog refresh');
            }
            if ((aliasCounts.get(target.key) ?? 0) > 1) {
                throw new Error(`Attached database alias ${JSON.stringify(target.key)} is not unique`);
            }

            let sql: string;
            if (target.path.startsWith('hyper.cloud')) {
                const result = await queryHyperCloudCatalog(
                    connectionId,
                    connectionDispatch,
                    updateId,
                    target.databaseName,
                    executor,
                    abortSignal,
                );
                sql = generateCatalogSQLFromHyperCloud(result, target.databaseName);
            } else {
                const result = await queryPgAttribute(
                    connectionId,
                    connectionDispatch,
                    updateId,
                    target.databaseName,
                    [],
                    executor,
                    target.queryDatabaseName,
                    abortSignal,
                );
                if (result == null || result.numRows === 0) {
                    throw new Error(`pg_attribute for ${target.databaseName} returned no relations`);
                }
                sql = generateCatalogSQLFromPgAttribute(result, target.databaseName);
            }
            if (!sql.trim()) throw new Error(`Catalog for ${target.databaseName} returned no usable relations`);
            return { target, sql, error: null };
        } catch (error) {
            return { target, sql: null, error: toError(error) };
        }
    }));

    validate();
    const successful = results.filter(result => result.sql != null);
    const failures = results
        .filter(result => result.error != null)
        .map(result => ({ database: result.target.key || result.target.path, error: result.error! }));
    if (successful.length === 0) {
        throw summarizeFailures('Failed to refresh every attached database', failures);
    }

    let functionSQL: string;
    if (resolveLiveFunctionCatalog) {
        const functionResult = await queryPgProc(
            connectionId,
            connectionDispatch,
            updateId,
            executor,
            abortSignal,
        );
        validate();
        if (functionResult == null) {
            throw new Error('pg_proc returned no Hyper function metadata result');
        }
        const functions = generateCatalogSQLFromPgProc(functionResult, DEFAULT_DATABASE_NAME, logger);
        functionSQL = `${generateFunctionScriptHeaderForSource('HyperDB WASM pg_proc')}${functions}`;
    } else {
        functionSQL = qualifyPrefetchedHyperFunctions(DEFAULT_DATABASE_NAME);
    }

    validate();
    const sections = parseCatalogSections(catalogRelationScript.toString());
    const desiredKeys = targets.map(target => target.key);
    for (const key of [...sections.keys()]) {
        if (!desiredKeys.includes(key)) sections.delete(key);
    }
    for (const result of successful) sections.set(result.target.key, result.sql!);

    const nextText = renderCatalogSections(
        sections,
        desiredKeys,
        resolveLiveFunctionCatalog ? 'HyperDB WASM pg_class' : null,
    );
    connectionDispatch(connectionId, {
        type: CATALOG_UPDATE_SCHEMA_SCRIPT,
        value: [updateId],
    });
    const [relations, functions] = await publishCatalogBatch(dql, catalog, [
        { script: catalogRelationScript, text: nextText, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK },
        { script: catalogFunctionScript, text: functionSQL, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, requireFunctions: !resolveLiveFunctionCatalog },
    ], options, validate);
    logger.info('Updated Hyper catalog relations', {
        updateId: updateId.toString(),
        databasesUpdated: successful.length.toString(),
        databasesFailed: failures.length.toString(),
        tables: relations.tables.toString(),
        functions: functions.functions.toString(),
    }, LOG_CTX);
    return {
        updatedDatabases: successful.map(result => result.target.key),
        failures,
    };
}
