import { VariantKind } from '../utils';
import { SALESFORCE_DATA_CLOUD, LOCAL_SCRIPT, HYPER_DATABASE, ConnectorAuthCheck } from './connector_info';
import { SalesforceAuthState } from './salesforce_auth_state';

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

export function writeSalesforceConnectorParams(params: URLSearchParams, state: SalesforceAuthState) {
    params.set('connector', 'salesforce');
    if (state.authParams?.instanceUrl) {
        params.set('instance', state.authParams?.instanceUrl);
    }
    if (state.authParams?.appConsumerKey) {
        params.set('app', state.authParams?.appConsumerKey);
    }
}

export function writeLocalConnectorParams(params: URLSearchParams) {
    params.set('connector', 'local');
}

export function writeHyperConnectorParams(params: URLSearchParams) {
    params.set('connector', 'hyper');
}

export function checkSalesforceAuthSetup(
    state: SalesforceAuthState,
    params: SalesforceSetupParams,
): ConnectorAuthCheck {
    if (!state.authParams) {
        return ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED;
    }
    if (state.authParams.appConsumerKey != params.appConsumerKey) {
        return ConnectorAuthCheck.CLIENT_ID_MISMATCH;
    }
    if (state.coreAccessToken || state.dataCloudAccessToken) {
        return ConnectorAuthCheck.AUTHENTICATED;
    }
    if (state.authStarted) {
        return ConnectorAuthCheck.AUTHENTICATION_IN_PROGRESS;
    }
    if (state.authError) {
        return ConnectorAuthCheck.AUTHENTICATION_FAILED;
    }
    return ConnectorAuthCheck.UNKNOWN;
}
