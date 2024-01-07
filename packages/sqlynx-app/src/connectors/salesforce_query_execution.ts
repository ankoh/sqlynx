import * as arrow from 'apache-arrow';

import { QueryExecutionResponseStream } from './query_execution';
import { SalesforceAPIClientInterface, SalesforceDataCloudAccessToken } from './salesforce_api_client';

export interface ExecuteDataCloudQueryTask {
    api: SalesforceAPIClientInterface;
    accessToken: SalesforceDataCloudAccessToken;
    scriptText: string;
}

export function executeQuery(
    scriptText: string,
    accessToken: SalesforceDataCloudAccessToken,
): QueryExecutionResponseStream {
    return null as any;
}
