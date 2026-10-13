import type { SalesforceConnectionParams } from '../connection_params.js';

export function createSalesforceConnectionParamsSignature(params: SalesforceConnectionParams): any {
    return {
        case: "salesforce",
        hyperProtocol: params.hyperProtocol,
        instanceUrl: params.instanceUrl,
        dataCloudInstanceUrl: params.dataCloudInstanceUrl,
        dataCloudTenantId: params.dataCloudTenantId,
        appConsumerKey: params.appConsumerKey,
        login: params.login,
    };
}
