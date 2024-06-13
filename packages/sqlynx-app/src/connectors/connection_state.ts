import * as proto from '@ankoh/sqlynx-pb';

import { HyperGrpcConnectionDetails } from './hyper_grpc_connection_state.js';
import { SalesforceConnectionDetails } from './salesforce_connection_state.js';
import { ConnectionStatistics, createConnectionStatistics } from './connection_statistics.js';
import { VariantKind } from '../utils/variant.js';
import { HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR } from './connector_info.js';
import {
    buildBrainstormConnectorParams,
    buildHyperConnectorParams,
    buildSalesforceConnectorParams,
} from './connection_params.js';
import { ConnectionHealth, ConnectionStatus } from './connection_status.js';

export type ConnectionDetailsVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectionDetails>
    | VariantKind<typeof SERVERLESS_CONNECTOR, ServerlessConnectionState>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcConnectionDetails>
    ;

export interface ConnectionState {
    /// The connection id
    connectionId: number;
    /// The connection state
    connectionStatus: ConnectionStatus;
    /// The connection health
    connectionHealth: ConnectionHealth;
    /// The connection statistics
    stats: ConnectionStatistics;
    /// The connection details
    details: ConnectionDetailsVariant;
}

export type ConnectionStateWithoutId = Omit<ConnectionState, "connectionId">;

export function createConnectionState(details: ConnectionDetailsVariant): ConnectionStateWithoutId {
    return {
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        stats: createConnectionStatistics(),
        details
    };
}

export interface ServerlessConnectionState {}

export enum ConnectorAuthCheck {
    UNKNOWN,
    AUTHENTICATED,
    AUTHENTICATION_FAILED,
    AUTHENTICATION_IN_PROGRESS,
    AUTHENTICATION_NOT_STARTED,
    CLIENT_ID_MISMATCH,
}

export function checkSalesforceAuth(
    state: SalesforceConnectionDetails | null,
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

export function buildConnectorParams(state: ConnectionDetailsVariant) {
    switch (state.type) {
        case SERVERLESS_CONNECTOR:
            return buildBrainstormConnectorParams();
        case HYPER_GRPC_CONNECTOR:
            return buildHyperConnectorParams();
        case SALESFORCE_DATA_CLOUD_CONNECTOR: {
            return buildSalesforceConnectorParams(state.value.authParams);
        }
    }
}
