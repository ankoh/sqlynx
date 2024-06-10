import * as proto from '@ankoh/sqlynx-pb';

import { HyperGrpcConnectionState } from './hyper_grpc_connection_state.js';
import { SalesforceConnectionState } from './salesforce_connection_state.js';
import { ConnectionStatistics } from './connection_statistics.js';
import { VariantKind } from '../utils/variant.js';
import {
    FILE_CONNECTOR,
    HYPER_GRPC_CONNECTOR,
    SALESFORCE_DATA_CLOUD_CONNECTOR,
} from './connector_info.js';
import {
    buildBrainstormConnectorParams,
    buildHyperConnectorParams,
    buildSalesforceConnectorParams,
} from './connection_params.js';

export type ConnectionState =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectionState>
    | VariantKind<typeof FILE_CONNECTOR, BrainstormConnectionState>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcConnectionState>
    ;

export interface BrainstormConnectionState {
    stats: ConnectionStatistics;
}

export function asHyperGrpcConnection(state: ConnectionState | null): HyperGrpcConnectionState | null {
    if (state == null) return null;
    switch (state.type) {
        case HYPER_GRPC_CONNECTOR: return state.value;
        default: return null;
    }
}

export function asSalesforceConnection(state: ConnectionState | null): SalesforceConnectionState | null {
    if (state == null) return null;
    switch (state.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR: return state.value;
        default: return null;
    }
}

export enum ConnectorAuthCheck {
    UNKNOWN,
    AUTHENTICATED,
    AUTHENTICATION_FAILED,
    AUTHENTICATION_IN_PROGRESS,
    AUTHENTICATION_NOT_STARTED,
    CLIENT_ID_MISMATCH,
}

export function checkSalesforceAuth(
    state: SalesforceConnectionState | null,
    params: proto.sqlynx_session.pb.SalesforceConnectorParams,
): ConnectorAuthCheck {
    if (!state) {
        return ConnectorAuthCheck.UNKNOWN;
    }
    if (!state.authParams) {
        return ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED;
    }
    if (state.authParams.appConsumerKey != params.appConsumerKey) {
        return ConnectorAuthCheck.CLIENT_ID_MISMATCH;
    }
    if (state.coreAccessToken || state.dataCloudAccessToken) {
        return ConnectorAuthCheck.AUTHENTICATED;
    }
    if (state.authTimings.authStartedAt) {
        return ConnectorAuthCheck.AUTHENTICATION_IN_PROGRESS;
    }
    if (state.authError) {
        return ConnectorAuthCheck.AUTHENTICATION_FAILED;
    }
    return ConnectorAuthCheck.UNKNOWN;
}

export function buildConnectorParams(state: ConnectionState) {
    switch (state.type) {
        case FILE_CONNECTOR:
            return buildBrainstormConnectorParams();
        case HYPER_GRPC_CONNECTOR:
            return buildHyperConnectorParams();
        case SALESFORCE_DATA_CLOUD_CONNECTOR: {
            return buildSalesforceConnectorParams(state.value.authParams);
        }
    }
}
