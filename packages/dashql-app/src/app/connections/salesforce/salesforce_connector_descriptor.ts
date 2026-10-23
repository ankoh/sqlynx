import type { ConnectorDescriptor } from '../connector_descriptor.js';
import { CONNECTOR_INFOS, ConnectorType, SALESFORCE_DATA_CLOUD_CONNECTOR } from '../connector_info.js';
import { SALESFORCE_CATALOG_DATABASE, SALESFORCE_CATALOG_SCHEMA } from './salesforce_catalog_update.js';
import { createSalesforceConnectionStateDetails, reduceSalesforceConnectionState } from './salesforce_connection_state.js';

/// Salesforce Data Cloud connections
export const SALESFORCE_CONNECTOR_DESCRIPTOR: ConnectorDescriptor<'salesforce'> = {
    info: CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD],
    paramsKey: 'salesforce',
    detailsType: SALESFORCE_DATA_CLOUD_CONNECTOR,
    defaultParams: () => ({ hyperProtocol: 'V3_HTTP', instanceUrl: '', appConsumerKey: '', appConsumerSecret: '', login: '' }),
    createDetails: createSalesforceConnectionStateDetails,
    reduce: reduceSalesforceConnectionState,
    withoutDraftRows: params => params,
    // Keep instanceUrl, appConsumerKey and the login hint; drop the connected-app secret.
    sanitizeForSharing: (params, withLoginHint) => ({ ...params, appConsumerSecret: "", ...(withLoginHint ? {} : { login: "" }) }),
    loginHint: params => params.login || null,
    cacheSignature: params => ({
        case: "salesforce",
        hyperProtocol: params.hyperProtocol,
        instanceUrl: params.instanceUrl,
        appConsumerKey: params.appConsumerKey,
        login: params.login,
    }),
    catalogNameDefaults: () => ({ databaseName: SALESFORCE_CATALOG_DATABASE, schemaName: SALESFORCE_CATALOG_SCHEMA }),
};
