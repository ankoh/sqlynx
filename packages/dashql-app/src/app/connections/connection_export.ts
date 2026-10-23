import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { ConnectionState } from "./connection_state.js";
import { sanitizeConnectionParamsForSharing } from './connection_params.js';
import { connectorOfDetails, connectorParams } from './connector_descriptor.js';

export function encodeConnectionAsProto(state: ConnectionState): connection.Connection {
    const connector = connectorOfDetails(state.details);
    const params = sanitizeConnectionParamsForSharing(state.params);
    const setupParams = connector.paramsKey in params ? connectorParams(connector, params) : undefined;
    return { [connector.paramsKey]: { setupTimings: {}, setupParams } } as connection.Connection;
}
