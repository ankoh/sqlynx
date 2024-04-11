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
    } else if (conn.auth.timings.openedAuthLinkAt) {
        state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK;
    } else if (conn.auth.timings.openedAuthWindowAt) {
        if (!conn.auth.timings.closedAuthWindowAt) {
            state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW;
        } else if (!conn.auth.timings.oauthCodeReceivedAt) {
            state = ConnectionStatus.OAUTH_CODE_RECEIVED;
        }
    } else if (conn.auth.timings.authRequestedAt) {
        state = ConnectionStatus.AUTHENTICATION_REQUESTED;
    }
    return state;
}

export function getSalesforceConnnectionHealth(_status: ConnectionStatus) {
    return ConnectionHealth.UNKNOWN;
}
