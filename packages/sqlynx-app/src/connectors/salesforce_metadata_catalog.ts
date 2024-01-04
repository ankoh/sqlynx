import * as sqlynx from '@ankoh/sqlynx';

import { SalesforceConnectorInterface, SalesforceDataCloudAccessToken } from './salesforce_api_client';

export const UPDATE_SALESFORCE_DATA_CLOUD_METADATA = Symbol('UPDATE_SALESFORCE_DATA_CLOUD_METADATA');

const METADATA_DESCRIPTOR_POOL_ID = 100;
const METADATA_DESCRIPTOR_POOL_RANK = 1e9;

export interface UpdateDataCloudMetadataTask {
    api: SalesforceConnectorInterface;
    accessToken: SalesforceDataCloudAccessToken;
}

export async function updateDataCloudMetadata(
    catalog: sqlynx.SQLynxCatalog,
    task: UpdateDataCloudMetadataTask,
    cancellation: AbortController,
): Promise<void> {
    // Get the data cloud metadata
    const result = await task.api.getDataCloudMetadata(task.accessToken, cancellation.signal);
    // Build the descriptor
    const schema = new sqlynx.proto.SchemaDescriptorT();
    for (const entity of result.metadata) {
        const table = new sqlynx.proto.SchemaTableT(entity.name);
        for (const column of entity.fields) {
            table.columns.push(new sqlynx.proto.SchemaTableColumnT(column.name));
        }
        schema.tables.push(table);
    }
    // Store the metadata in the descriptor pool

    // XXX Uncomment when scripts are re-analyzed after the catalog update
    console.log('catalog.clear()');
    // catalog.clear();
    // catalog.addDescriptorPool(METADATA_DESCRIPTOR_POOL_ID, METADATA_DESCRIPTOR_POOL_RANK);
    // catalog.addSchemaDescriptorT(METADATA_DESCRIPTOR_POOL_ID, schema);
}
