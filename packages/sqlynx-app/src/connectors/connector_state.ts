import { HyperDatabaseConnection } from "../platform/hyperdb_client.js";
import { VariantKind } from "../utils/variant.js";
import { BRAINSTORM_MODE, HYPER_DATABASE, SALESFORCE_DATA_CLOUD } from "./connector_info.js";
import { SalesforceAuthState } from "./salesforce_auth_state.js";

export type ConnectorState =
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
