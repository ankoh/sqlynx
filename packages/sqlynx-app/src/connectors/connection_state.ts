import { HyperDatabaseConnection } from "../platform/hyperdb_client.js";
import { VariantKind } from "../utils/variant.js";
import { BRAINSTORM_MODE, HYPER_DATABASE, SALESFORCE_DATA_CLOUD } from "./connector_info.js";
import { SalesforceAuthState } from "./salesforce_auth_state.js";

export type ConnectionState =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD, SalesforceConnectorState>
    | VariantKind<typeof BRAINSTORM_MODE, BrainstormConnectorState>
    | VariantKind<typeof HYPER_DATABASE, HyperDBConnectorState>
    ;

export interface BrainstormConnectorState {
}

export interface SalesforceConnectorState {
    auth: SalesforceAuthState;
}

export interface HyperDBConnectorState {
    connection: HyperDatabaseConnection;
}

export enum ConnectionStatus {
    UNKNOWN,
    NOT_STARTED,
    PKCE_GENERATION_STARTED,
    OAUTH_CODE_RECEIVED,
    DATA_CLOUD_TOKEN_REQUESTED,
    CORE_ACCESS_TOKEN_REQUESTED,
    WAITING_FOR_OAUTH_CODE_VIA_POPUP,
    WAITING_FOR_OAUTH_CODE_VIA_LINK,
    AUTHENTICATION_REQUESTED,
    AUTHENTICATION_FAILED,
    AUTHENTICATION_COMPLETED,
    UNSUPPORTED,
}

export function getConnectionStatus(conn: ConnectionState) {
    switch (conn.type) {
        case SALESFORCE_DATA_CLOUD: {
            let state: ConnectionStatus;
            if (!conn.value.auth.authStarted) {
                state = ConnectionStatus.NOT_STARTED;
            } else if (conn.value.auth.authError) {
                state = ConnectionStatus.AUTHENTICATION_FAILED;
            } else if (conn.value.auth.openAuthWindow != null) {
                state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_POPUP;
            } else if (conn.value.auth.timings.dataCloudAccessTokenReceievedAt) {
                state = ConnectionStatus.AUTHENTICATION_COMPLETED;
            } else if (conn.value.auth.timings.dataCloudAccessTokenRequestedAt) {
                state = ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED;
            } else if (conn.value.auth.timings.coreAccessTokenRequestedAt) {
                state = ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED;
            } else if (conn.value.auth.timings.pkceGenStartedAt) {
                state = ConnectionStatus.PKCE_GENERATION_STARTED;
            } else if (conn.value.auth.timings.openedAuthLinkAt) {
                state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK;
            } else if (conn.value.auth.timings.openedAuthWindowAt) {
                if (!conn.value.auth.timings.closedAuthWindowAt) {
                    state = ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_POPUP;
                } else if (!conn.value.auth.timings.oauthCodeReceivedAt) {
                    state = ConnectionStatus.OAUTH_CODE_RECEIVED;
                }
            } else if (conn.value.auth.timings.authRequestedAt) {
                state = ConnectionStatus.AUTHENTICATION_REQUESTED;
            }
            break;
        }
        default:
            return ConnectionStatus.UNSUPPORTED;
    }
}

