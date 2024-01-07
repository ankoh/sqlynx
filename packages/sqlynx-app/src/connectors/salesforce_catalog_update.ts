import * as sqlynx from '@ankoh/sqlynx';

import { SalesforceMetadata } from './salesforce_api_client';

export function updateDataCloudCatalog(_catalog: sqlynx.SQLynxCatalog, _metadata: SalesforceMetadata) {
    console.log('catalog.clear()');
}
