import * as arrow from "apache-arrow";
import * as dashql from '@ankoh/dashql-core';
import * as flatbuffers from 'flatbuffers';

import { QueryExecutor } from './query_executor.js';
import { QueryExecutionArgs } from './query_execution_args.js';
import { DynamicConnectionDispatch } from "./connection_registry.js";
import { CATALOG_UPDATE_LOAD_DESCRIPTORS, CATALOG_UPDATE_REGISTER_QUERY } from "./connection_state.js";
import { QueryType } from "./query_execution_state.js";
import { CATALOG_DEFAULT_DESCRIPTOR_POOL, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from "./catalog_update_state.js";

export type InformationSchemaColumnsTable = arrow.Table<{
    table_catalog: arrow.Utf8;
    table_schema: arrow.Utf8;
    table_name: arrow.Utf8;
    column_name: arrow.Utf8;
    ordinal_position: arrow.Int32;
    is_nullable: arrow.Utf8;  // 'YES' or 'NO'
    data_type: arrow.Utf8;
}>;

function collectSchemaDescriptors(result: InformationSchemaColumnsTable): dashql.proto.SchemaDescriptorT[] {
    // Iterate over all record batches
    const catalogs = new Map<string, Map<string, Map<string, dashql.proto.SchemaTableT>>>();
    for (const batch of result.batches) {
        const colTableCatalog = batch.getChild("table_catalog")!;
        const colTableSchema = batch.getChild("table_schema")!;
        const colTableName = batch.getChild("table_name")!;
        const colColumnName = batch.getChild("column_name")!;
        // const colOrdinalPos = batch.getChild("ordinal_position")!;

        // Iterate over all rows in the batch
        for (let i = 0; i < batch.numRows; ++i) {
            const tableCatalog = colTableCatalog.at(i);
            const tableSchema = colTableSchema.at(i);
            const tableName = colTableName.at(i);
            const columnName = colColumnName.at(i);
            // const ordinalPosition = colOrdinalPos.at(i); XXX

            if (!tableCatalog || !tableSchema || !columnName || !tableName) {
                continue;
            }

            let nextTableId = 0;
            const schemaMap = catalogs.get(tableCatalog);
            if (!schemaMap) {
                // Catalog does not exist, create a new map for schema tables
                const tableMap = new Map<string, dashql.proto.SchemaTableT>();
                tableMap.set(tableName, new dashql.proto.SchemaTableT(nextTableId++, tableName, [
                    new dashql.proto.SchemaTableColumnT(columnName, 0),
                ]));
                const schemaMap = new Map<string, Map<string, dashql.proto.SchemaTableT>>();
                schemaMap.set(tableSchema, tableMap);
                catalogs.set(tableCatalog, schemaMap);

            } else {
                // Schema does not exist, create a new map for tables
                let tableMap = schemaMap.get(tableSchema);
                if (!tableMap) {
                    tableMap = new Map<string, dashql.proto.SchemaTableT>();
                    tableMap.set(tableName, new dashql.proto.SchemaTableT(nextTableId++, tableName, [
                        new dashql.proto.SchemaTableColumnT(columnName),
                    ]));
                    schemaMap.set(tableSchema, tableMap);

                } else {
                    const table = tableMap.get(tableName);
                    if (!table) {
                        // Table does not exist, create a new table
                        tableMap.set(tableName, new dashql.proto.SchemaTableT(nextTableId++, tableName, [
                            new dashql.proto.SchemaTableColumnT(columnName, 0),
                        ]));
                    } else {
                        table.columns.push(new dashql.proto.SchemaTableColumnT(columnName, table.columns.length));
                    }
                }
            }
        }
    }

    // Collect all schema descriptors
    const descriptors: dashql.proto.SchemaDescriptorT[] = [];
    for (const [catalogName, catalogSchemas] of catalogs) {
        for (const [schemaName, schemaTables] of catalogSchemas) {
            const descriptor = new dashql.proto.SchemaDescriptorT(catalogName, schemaName, []);
            for (const [_tableName, table] of schemaTables) {
                descriptor.tables.push(table);
            }
            descriptors.push(descriptor)
        }
    }
    return descriptors;
}

export async function queryInformationSchema(connectionId: number, connectionDispatch: DynamicConnectionDispatch, updateId: number, catalogName: string, schemaNames: string[], executor: QueryExecutor): Promise<InformationSchemaColumnsTable | null> {
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
            queryType: QueryType.CATALOG_QUERY_INFORMATION_SCHEMA,
            title: "Information Schema",
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
    return queryResult;
}

export async function updateInformationSchemaCatalog(connectionId: number, connectionDispatch: DynamicConnectionDispatch, updateId: number, catalogName: string, schemaNames: string[], executor: QueryExecutor, catalog: dashql.DashQLCatalog): Promise<void> {
    // Query the information schema
    const queryResult = await queryInformationSchema(connectionId, connectionDispatch, updateId, catalogName, schemaNames, executor);
    if (queryResult == null) {
        return;
    }

    // Load the descriptors
    connectionDispatch(connectionId, {
        type: CATALOG_UPDATE_LOAD_DESCRIPTORS,
        value: [updateId]
    });

    const descriptors = collectSchemaDescriptors(queryResult);

    // Update the catalog
    catalog.dropDescriptorPool(CATALOG_DEFAULT_DESCRIPTOR_POOL);
    catalog.addDescriptorPool(CATALOG_DEFAULT_DESCRIPTOR_POOL, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK);
    for (const descriptor of descriptors) {
        catalog.addSchemaDescriptorT(CATALOG_DEFAULT_DESCRIPTOR_POOL, descriptor);
    }
}
