import { VariantKind } from '../utils';
import { SALESFORCE_DATA_CLOUD, LOCAL_SCRIPT, HYPER_DATABASE } from './connector_info';

export interface SalesforceSetupParams {
    clientId?: string;
}
export interface LocalSetupParams {}
export interface HyperSetupParams {}

export type ConnectorSetupParamVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD, SalesforceSetupParams>
    | VariantKind<typeof LOCAL_SCRIPT, LocalSetupParams>
    | VariantKind<typeof HYPER_DATABASE, HyperSetupParams>;

function readSalesforceConnectorParamsFromURL(urlParams: URLSearchParams): ConnectorSetupParamVariant {
    return {
        type: SALESFORCE_DATA_CLOUD,
        value: {},
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

export function readConnectorParamsFromURL(url: URL): ConnectorSetupParamVariant | null {
    const urlParams = new URLSearchParams(url.search);
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
