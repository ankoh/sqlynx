import * as proto from '@ankoh/sqlynx-pb';

import { HyperGrpcConnectionState } from './hyper_grpc_connection_state.js';
import { SalesforceConnectorState } from './salesforce_connection_state.js';
import { ConnectionStatistics } from './connection_statistics.js';
import { VariantKind } from '../utils/variant.js';
import {
    BRAINSTORM_CONNECTOR,
    HYPER_GRPC_CONNECTOR,
    SALESFORCE_DATA_CLOUD_CONNECTOR,
} from './connector_info.js';
import {
    buildBrainstormConnectorParams,
    buildHyperConnectorParams,
    buildSalesforceConnectorParams,
} from './connection_params.js';

export type ConnectionState =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectorState>
    | VariantKind<typeof BRAINSTORM_CONNECTOR, BrainstormConnectionState>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcConnectionState>
    ;

export interface BrainstormConnectionState {
    stats: ConnectionStatistics;
}

export enum ConnectionHealth {
    UNKNOWN,
    NOT_STARTED,
    CONNECTING,
    ONLINE,
    FAILED,
}

export enum ConnectionStatus {
    UNKNOWN,
    NOT_STARTED,
    PKCE_GENERATION_STARTED,
    OAUTH_CODE_RECEIVED,
    DATA_CLOUD_TOKEN_REQUESTED,
    CORE_ACCESS_TOKEN_REQUESTED,
    WAITING_FOR_OAUTH_CODE_VIA_WINDOW,
    WAITING_FOR_OAUTH_CODE_VIA_LINK,
    AUTHENTICATION_REQUESTED,
    AUTHORIZATION_FAILED,
    AUTHORIZATION_COMPLETED,
}

export enum ConnectorAuthCheck {
    UNKNOWN,
    AUTHENTICATED,
    AUTHENTICATION_FAILED,
    AUTHENTICATION_IN_PROGRESS,
    AUTHENTICATION_NOT_STARTED,
    CLIENT_ID_MISMATCH,
}

export function asHyperGrpcConnection(state: ConnectionState | null): HyperGrpcConnectionState | null {
    if (state == null) return null;
    switch (state.type) {
        case HYPER_GRPC_CONNECTOR: return state.value;
        default: return null;
    }
}

export function asSalesforceConnection(state: ConnectionState | null): SalesforceConnectorState | null {
    if (state == null) return null;
    switch (state.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR: return state.value;
        default: return null;
    }
}

export function getHyperGrpcConnectionStatus(conn: HyperGrpcConnectionState | null): ConnectionStatus {
    if (!conn) {
        return ConnectionStatus.UNKNOWN;
    }
    let state: ConnectionStatus = ConnectionStatus.UNKNOWN;
    if (!conn) {
        state = ConnectionStatus.NOT_STARTED;
    } else if (conn.channelError) {
        state = ConnectionStatus.AUTHORIZATION_FAILED;
    }
    return state;
}

export function getSalesforceConnectionStatus(conn: SalesforceConnectorState | null): ConnectionStatus {
    if (!conn) {
        return ConnectionStatus.UNKNOWN;
    }
    let state: ConnectionStatus = ConnectionStatus.UNKNOWN;
    if (!conn.authTimings.authStartedAt) {
        state = ConnectionStatus.NOT_STARTED;
    } else if (conn.authError) {
        state = ConnectionStatus.AUTHORIZATION_FAILED;
    } else if (conn.openAuthWindow != null) {
        state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW;
    } else if (conn.authTimings.dataCloudAccessTokenReceievedAt) {
        state = ConnectionStatus.AUTHORIZATION_COMPLETED;
    } else if (conn.authTimings.dataCloudAccessTokenRequestedAt) {
        state = ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED;
    } else if (conn.authTimings.coreAccessTokenRequestedAt) {
        state = ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED;
    } else if (conn.authTimings.openedNativeAuthLinkAt) {
        state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK;
    } else if (conn.authTimings.openedWebAuthWindowAt) {
        if (!conn.authTimings.closedWebAuthWindowAt) {
            state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW;
        } else if (!conn.authTimings.oauthCodeReceivedAt) {
            state = ConnectionStatus.OAUTH_CODE_RECEIVED;
        }
    } else if (conn.authTimings.pkceGenStartedAt) {
        state = ConnectionStatus.PKCE_GENERATION_STARTED;
    } else if (conn.authTimings.authStartedAt) {
        state = ConnectionStatus.AUTHENTICATION_REQUESTED;
    }
    return state;
}

export function getSalesforceConnectionHealth(status: ConnectionStatus): ConnectionHealth {
    switch (status) {
        case ConnectionStatus.UNKNOWN:
        case ConnectionStatus.NOT_STARTED:
            return ConnectionHealth.NOT_STARTED;
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK:
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW:
        case ConnectionStatus.PKCE_GENERATION_STARTED:
        case ConnectionStatus.OAUTH_CODE_RECEIVED:
        case ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED:
        case ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED:
        case ConnectionStatus.AUTHENTICATION_REQUESTED:
            return ConnectionHealth.CONNECTING;
        case ConnectionStatus.AUTHORIZATION_COMPLETED:
            return ConnectionHealth.ONLINE;
        case ConnectionStatus.AUTHORIZATION_FAILED:
            return ConnectionHealth.FAILED;
    }
}

export function checkSalesforceAuth(
    state: SalesforceConnectorState | null,
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
        case BRAINSTORM_CONNECTOR:
            return buildBrainstormConnectorParams();
        case HYPER_GRPC_CONNECTOR:
            return buildHyperConnectorParams();
        case SALESFORCE_DATA_CLOUD_CONNECTOR: {
            return buildSalesforceConnectorParams(state.value.authParams);
        }
    }
}
