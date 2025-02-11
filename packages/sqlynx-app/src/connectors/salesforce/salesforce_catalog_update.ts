import * as sqlynx from '@ankoh/sqlynx-core';

import { SalesforceApiClientInterface } from './salesforce_api_client.js';
import { SalesforceConnectionDetails } from './salesforce_connection_state.js';

export async function updateSalesforceCatalog(conn: SalesforceConnectionDetails, catalog: sqlynx.SQLynxCatalog, api: SalesforceApiClientInterface, abortController: AbortController) {
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
    const tables: sqlynx.proto.SchemaTableT[] = [];
    if (metadata.metadata) {
        for (const entry of metadata.metadata) {
            const table = new sqlynx.proto.SchemaTableT();
            table.tableName = entry.name;
            if (entry.fields) {
                for (const field of entry.fields) {
                    table.columns.push(new sqlynx.proto.SchemaTableColumnT(field.name));
                }
            }
            tables.push(table);
        }
    }

    catalog.dropDescriptorPool(42);
    catalog.addDescriptorPool(42, 100);
    const descriptor = new sqlynx.proto.SchemaDescriptorT('', '', tables);
    catalog.addSchemaDescriptorT(42, descriptor);
}
