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
    AUTHENTICATION_REQUESTED,
    WAITING_FOR_OAUTH,
    AUTHENTICATION_FAILED,
    CONNNECTING,
    CONNNECTION_FAILED,
    READY_FOR_QUERY,
    UNSUPPORTED,
}

export function getConnectionStatus(conn: ConnectionState) {
    switch (conn.type) {
        case SALESFORCE_DATA_CLOUD: {
            let state: ConnectionStatus;
            if (conn.value.auth.authError) {
                state = ConnectionStatus.AUTHENTICATION_FAILED;
            } else if (conn.value.auth.openAuthWindow != null) {
                state = ConnectionStatus.WAITING_FOR_OAUTH;
            } else if (conn.value.auth.authRequested) {
                state = ConnectionStatus.AUTHENTICATION_REQUESTED;
            }
            break;
        }
        default:
            return ConnectionStatus.UNSUPPORTED;
    }
}

