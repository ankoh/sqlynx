import * as dashql from '@ankoh/dashql-core';

import { SalesforceApiClientInterface } from './salesforce_api_client.js';
import { SalesforceConnectionDetails } from './salesforce_connection_state.js';

export async function updateSalesforceCatalog(conn: SalesforceConnectionDetails, catalog: dashql.DashQLCatalog, api: SalesforceApiClientInterface, abortController: AbortController) {
    // Missing the data cloud access token
    if (!conn.dataCloudAccessToken) {
        throw new Error(`salesforce data cloud access token is missing`);
    }
    // Get the Data Cloud metadata
    const metadata = await api.getDataCloudMetadata(
        conn.dataCloudAccessToken!,
        abortController.signal,
    );

    // Translate tables
    const tables: dashql.proto.SchemaTableT[] = [];
    if (metadata.metadata) {
        for (const entry of metadata.metadata) {
            const table = new dashql.proto.SchemaTableT();
            table.tableName = entry.name;
            if (entry.fields) {
                for (const field of entry.fields) {
                    table.columns.push(new dashql.proto.SchemaTableColumnT(field.name));
                }
            }
            tables.push(table);
        }
    }

    catalog.dropDescriptorPool(42);
    catalog.addDescriptorPool(42, 100);
    const descriptor = new dashql.proto.SchemaDescriptorT('', '', tables);
    catalog.addSchemaDescriptorT(42, descriptor);
}
