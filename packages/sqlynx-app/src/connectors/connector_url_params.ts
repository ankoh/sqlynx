import { VariantKind } from '../utils/index.js';
import { SALESFORCE_DATA_CLOUD, BRAINSTORM_MODE, HYPER_DATABASE, ConnectorAuthCheck } from './connector_info.js';
import { SalesforceAuthState } from './salesforce_auth_state.js';

export interface SalesforceSetupParams {
    instanceUrl: string | null;
    appConsumerKey: string | null;
}
export interface BrainstormSetupParams { }
export interface HyperSetupParams { }

export type ConnectorSetupParamVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD, SalesforceSetupParams>
    | VariantKind<typeof BRAINSTORM_MODE, BrainstormSetupParams>
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

function readBrainstormConnectorParamsFromURL(urlParms: URLSearchParams): ConnectorSetupParamVariant {
    return {
        type: BRAINSTORM_MODE,
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
        case 'sfdc':
            return readSalesforceConnectorParamsFromURL(urlParams);
        case 'hyper':
            return readHyperConnectorParamsFromURL(urlParams);
        case 'none':
        default:
            return readBrainstormConnectorParamsFromURL(urlParams);
    }
}

export function writeSalesforceConnectorParams(publicParams: URLSearchParams, privateParams: URLSearchParams, state: SalesforceAuthState) {
    publicParams.set('connector', 'sfdc');
    if (state.authParams?.instanceUrl) {
        publicParams.set('instance', state.authParams?.instanceUrl);
    }
    if (state.authParams?.appConsumerKey) {
        publicParams.set('app', state.authParams?.appConsumerKey);
    }
}

export function writeBrainstormConnectorParams(publicParams: URLSearchParams, _privateParams: URLSearchParams) {
    publicParams.set('connector', 'none');
}

export function writeHyperConnectorParams(publicParams: URLSearchParams, _privateParams: URLSearchParams) {
    publicParams.set('connector', 'hyper');
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
