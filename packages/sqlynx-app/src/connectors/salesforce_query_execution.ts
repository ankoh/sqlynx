import { SalesforceAPIClientInterface, SalesforceDataCloudAccessToken } from './salesforce_api_client';

export interface ExecuteDataCloudQueryTask {
    api: SalesforceAPIClientInterface;
    accessToken: SalesforceDataCloudAccessToken;
    scriptText: string;
}

export async function executeQuery(task: ExecuteDataCloudQueryTask) {
    // Create arrow batch
}
