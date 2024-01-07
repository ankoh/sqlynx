import * as arrow from 'apache-arrow';

import { QueryExecutionResponseStream } from './query_execution';
import { SalesforceDataCloudAccessToken } from './salesforce_api_client';

export function executeQuery(
    _scriptText: string,
    _accessToken: SalesforceDataCloudAccessToken,
): QueryExecutionResponseStream {
    throw new Error('Method not implemented.');
}
