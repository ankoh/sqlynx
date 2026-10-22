import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { ConnectionState } from "./connection_state.js";
import { HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import { sanitizeConnectionParamsForSharing } from './connection_params.js';

export function encodeConnectionAsProto(state: ConnectionState): connection.Connection {
    const params = sanitizeConnectionParamsForSharing(state.params);
    switch (state.details.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return {
                salesforce: { setupTimings: {}, setupParams: 'salesforce' in params ? params.salesforce : undefined } as connection.SalesforceConnectionDetails,
            };
        case HYPER_CONNECTOR:
            return {
                hyper: { setupTimings: {}, setupParams: 'hyper' in params ? params.hyper : undefined } as connection.HyperConnectionDetails,
            };
        case TRINO_CONNECTOR:
            return {
                trino: { setupTimings: {}, setupParams: 'trino' in params ? params.trino : undefined } as connection.TrinoConnectionDetails,
            };
    }
}
