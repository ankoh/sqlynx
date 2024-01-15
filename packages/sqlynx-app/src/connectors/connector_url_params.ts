import { VariantKind } from '../utils';
import { SALESFORCE_DATA_CLOUD, LOCAL_SCRIPT, HYPER_DATABASE } from './connector_info';

export interface SalesforceSetupParams {
    instanceUrl: string | null;
    appConsumerKey: string | null;
}
export interface LocalSetupParams {}
export interface HyperSetupParams {}

export type ConnectorSetupParamVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD, SalesforceSetupParams>
    | VariantKind<typeof LOCAL_SCRIPT, LocalSetupParams>
    | VariantKind<typeof HYPER_DATABASE, HyperSetupParams>;

function readSalesforceConnectorParamsFromURL(urlParams: URLSearchParams): ConnectorSetupParamVariant {
    const result: SalesforceSetupParams = {
        instanceUrl: urlParams.get('instance') ?? null,
        appConsumerKey: urlParams.get('app') ?? null,
    };
    return {
        type: SALESFORCE_DATA_CLOUD,
        value: result,
    };
}

function readLocalConnectorParamsFromURL(urlParms: URLSearchParams): ConnectorSetupParamVariant {
    return {
        type: LOCAL_SCRIPT,
        value: {},
    };
}

function readHyperConnectorParamsFromURL(urlParams: URLSearchParams): ConnectorSetupParamVariant {
    return {
        type: HYPER_DATABASE,
        value: {},
    };
}

export function readConnectorParamsFromURL(urlParams: URLSearchParams): ConnectorSetupParamVariant | null {
    switch (urlParams.get('connector') ?? null) {
        case 'salesforce':
            return readSalesforceConnectorParamsFromURL(urlParams);
        case 'hyper':
            return readHyperConnectorParamsFromURL(urlParams);
        case 'local':
        default:
            return readLocalConnectorParamsFromURL(urlParams);
    }
}
