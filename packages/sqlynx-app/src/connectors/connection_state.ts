import { HyperDatabaseConnection } from "../platform/hyperdb_client.js";
import { VariantKind } from "../utils/variant.js";
import { BRAINSTORM_MODE, HYPER_DATABASE, SALESFORCE_DATA_CLOUD } from "./connector_info.js";
import { SalesforceAuthState } from "./salesforce_auth_state.js";

export type ConnectionState =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD, SalesforceConnectorState>
    | VariantKind<typeof BRAINSTORM_MODE, BrainstormConnectorState>
    | VariantKind<typeof HYPER_DATABASE, HyperDBConnectorState>
    ;

export interface ConnectionTimings {
    totalQueriesStarted: BigInt;
    totalQueriesFinished: BigInt;
    totalQueryDurationMs: BigInt;
    lastQueryStarted: Date | null;
    lastQueryFinished: Date | null;
}

export interface BrainstormConnectorState {
    timings: ConnectionTimings;
}

export interface SalesforceConnectorState {
    timings: ConnectionTimings;
    auth: SalesforceAuthState;
}

export interface HyperDBConnectorState {
    connectionTimings: ConnectionTimings;
    connection: HyperDatabaseConnection;
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
    AUTHENTICATION_FAILED,
    AUTHENTICATION_COMPLETED,
}

export function createEmptyTimings(): ConnectionTimings {
    return {
        totalQueriesStarted: BigInt(0),
        totalQueriesFinished: BigInt(0),
        totalQueryDurationMs: BigInt(0),
        lastQueryStarted: null,
        lastQueryFinished: null
    };
}

export function unpackSalesforceConnection(state: ConnectionState | null): SalesforceConnectorState | null {
    if (state == null) return null;
    switch (state.type) {
        case SALESFORCE_DATA_CLOUD: return state.value;
        default: return null;
    }
}

export function getSalesforceConnectionStatus(conn: SalesforceConnectorState | null): ConnectionStatus {
    if (!conn) {
        return ConnectionStatus.UNKNOWN;
    }
    let state: ConnectionStatus = ConnectionStatus.UNKNOWN;
    if (!conn.auth.authStarted) {
        state = ConnectionStatus.NOT_STARTED;
    } else if (conn.auth.authError) {
        state = ConnectionStatus.AUTHENTICATION_FAILED;
    } else if (conn.auth.openAuthWindow != null) {
        state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW;
    } else if (conn.auth.timings.dataCloudAccessTokenReceievedAt) {
        state = ConnectionStatus.AUTHENTICATION_COMPLETED;
    } else if (conn.auth.timings.dataCloudAccessTokenRequestedAt) {
        state = ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED;
    } else if (conn.auth.timings.coreAccessTokenRequestedAt) {
        state = ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED;
    } else if (conn.auth.timings.pkceGenStartedAt) {
        state = ConnectionStatus.PKCE_GENERATION_STARTED;
    } else if (conn.auth.timings.openedNativeAuthLinkAt) {
        state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK;
    } else if (conn.auth.timings.openedWebAuthWindowAt) {
        if (!conn.auth.timings.closedWebAuthWindowAt) {
            state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW;
        } else if (!conn.auth.timings.oauthCodeReceivedAt) {
            state = ConnectionStatus.OAUTH_CODE_RECEIVED;
        }
    } else if (conn.auth.timings.authRequestedAt) {
        state = ConnectionStatus.AUTHENTICATION_REQUESTED;
    }
    return state;
}

export function getSalesforceConnnectionHealth(status: ConnectionStatus): ConnectionHealth {
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
        case ConnectionStatus.AUTHENTICATION_COMPLETED:
            return ConnectionHealth.ONLINE;
        case ConnectionStatus.AUTHENTICATION_FAILED:
            return ConnectionHealth.FAILED;
    }
}
