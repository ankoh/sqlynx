import * as arrow from "apache-arrow";
import * as sqlynx from '@ankoh/sqlynx-core';

import { QueryExecutor } from './query_executor.js';
import { QueryExecutionArgs } from './query_execution_args.js';
import { DynamicConnectionDispatch } from "./connection_registry.js";
import { CATALOG_UPDATE_REGISTER_QUERY } from "./connection_state.js";

export type InformationSchemaColumnsTable = arrow.Table<{
    table_catalog: arrow.Utf8;
    table_schema: arrow.Utf8;
    table_name: arrow.Utf8;
    column_name: arrow.Utf8;
    ordinal_position: arrow.Int32;
    is_nullable: arrow.Utf8;  // 'YES' or 'NO'
    data_type: arrow.Utf8;
}>;

function collectSchemaDescriptors(result: InformationSchemaColumnsTable): sqlynx.proto.SchemaDescriptorT[] {
    // Iterate over all record batches
    const catalogs = new Map<string, Map<string, Map<string, sqlynx.proto.SchemaTableT>>>();
    for (const batch of result.batches) {
        const colTableCatalog = batch.getChild("table_catalog")!;
        const colTableSchema = batch.getChild("table_schema")!;
        const colTableName = batch.getChild("table_name")!;
        const colColumnName = batch.getChild("column_name")!;
        const colOrdinalPos = batch.getChild("ordinal_position")!;

        // Iterate over all rows in the batch
        for (let i = 0; i < batch.numRows; ++i) {
            const tableCatalog = colTableCatalog.at(i);
            const tableSchema = colTableSchema.at(i);
            const tableName = colTableName.at(i);
            const columnName = colColumnName.at(i);
            const ordinalPosition = colOrdinalPos.at(i);

            if (!tableCatalog || !tableSchema || !columnName || !tableName || !ordinalPosition) {
                continue;
            }

            let nextTableId = 0;
            const schemaMap = catalogs.get(tableCatalog);
            if (!schemaMap) {
                // Catalog does not exist, create a new map for schema tables
                const tableMap = new Map<string, sqlynx.proto.SchemaTableT>();
                tableMap.set(tableName, new sqlynx.proto.SchemaTableT(nextTableId++, tableName, [
                    new sqlynx.proto.SchemaTableColumnT(columnName),
                ]));
                const schemaMap = new Map<string, Map<string, sqlynx.proto.SchemaTableT>>();
                schemaMap.set(tableSchema, tableMap);
                catalogs.set(tableCatalog, schemaMap);

            } else {
                // Schema does not exist, create a new map for tables
                let tableMap = schemaMap.get(tableSchema);
                if (!tableMap) {
                    tableMap = new Map<string, sqlynx.proto.SchemaTableT>();
                    tableMap.set(tableName, new sqlynx.proto.SchemaTableT(nextTableId++, tableName, [
                        new sqlynx.proto.SchemaTableColumnT(columnName),
                    ]));
                    schemaMap.set(tableSchema, tableMap);

                } else {
                    const table = tableMap.get(tableName);
                    if (!table) {
                        // Table does not exist, create a new table
                        tableMap.set(tableName, new sqlynx.proto.SchemaTableT(nextTableId++, tableName, [
                            new sqlynx.proto.SchemaTableColumnT(columnName, ordinalPosition),
                        ]));
                    } else {
                        table.columns.push(new sqlynx.proto.SchemaTableColumnT(columnName));
                    }
                }
            }
        }
    }

    // Collect all schema descriptors
    const descriptors: sqlynx.proto.SchemaDescriptorT[] = [];
    for (const [catalogName, catalogSchemas] of catalogs) {
        for (const [schemaName, schemaTables] of catalogSchemas) {
            const descriptor = new sqlynx.proto.SchemaDescriptorT(catalogName, schemaName, []);
            for (const [_tableName, table] of schemaTables) {
                descriptor.tables.push(table);
            }
            descriptors.push(descriptor)
        }
    }
    return descriptors;
}

export async function queryInformationSchema(connectionId: number, connectionDispatch: DynamicConnectionDispatch, updateId: number, catalogName: string, schemaNames: string[], executor: QueryExecutor): Promise<void> {
    const query = `
        SELECT
            table_catalog,
            table_schema,
            table_name,
            column_name,
            ordinal_position,
            is_nullable,
            data_type
        FROM information_schema.columns 
        WHERE table_catalog = '${catalogName}'
        ${schemaNames.length > 0 ? `AND table_schema IN ('${schemaNames.join("','")}')` : ''}
    `;

    const args: QueryExecutionArgs = {
        query: query,
        metadata: {
            title: "Query Information Schema Columns",
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

    const queryResult = await queryExecution as InformationSchemaColumnsTable;

    if (queryResult == null) {
        // XXX
        return;
    }

    const descriptors = collectSchemaDescriptors(queryResult);
    console.log(descriptors);
}

export async function updateInformationSchemaCatalog(connectionId: number, connectionDispatch: DynamicConnectionDispatch, updateId: number, catalogName: string, schemaNames: string[], executor: QueryExecutor, _catalog: sqlynx.SQLynxCatalog): Promise<void> {
    await queryInformationSchema(connectionId, connectionDispatch, updateId, catalogName, schemaNames, executor);
}
