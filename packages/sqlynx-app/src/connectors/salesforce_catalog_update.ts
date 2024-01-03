import { SQLynxCatalog } from '@ankoh/sqlynx';
import { SalesforceConnectorInterface, SalesforceDataCloudAccessToken } from './salesforce_api_client';

export const UPDATE_SALESFORCE_DATA_CLOUD_METADATA = Symbol('UPDATE_SALESFORCE_DATA_CLOUD_METADATA');

export interface UpdateDataCloudMetadataTask {
    api: SalesforceConnectorInterface;
    accessToken: SalesforceDataCloudAccessToken;
}

export async function updateDataCloudMetadata(
    catalog: SQLynxCatalog,
    task: UpdateDataCloudMetadataTask,
    cancellation: AbortController,
): Promise<void> {
    const result = await task.api.getDataCloudMetadata(task.accessToken, cancellation.signal);

    catalog.clear();
    // Register salesforce tables
}
