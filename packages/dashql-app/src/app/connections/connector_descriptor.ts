import type { CatalogNameDefaults } from '@ankoh/dashql-core';

import type { ConnectionParams, HyperConnectionParams, SalesforceConnectionParams, TrinoConnectionParams } from './connection_params.js';
import type { ConnectionStateDetailsVariant } from './connection_state_details.js';
import type { ConnectionAction, ConnectionState } from './connection_state.js';
import type { HyperConnectionDetails } from './hyper/hyper_connection_state.js';
import type { SalesforceConnectionStateDetails } from './salesforce/salesforce_connection_state.js';
import type { TrinoConnectionStateDetails } from './trino/trino_connection_state.js';
import { ConnectorType, type ConnectorInfo } from './connector_info.js';
import { HYPER_CONNECTOR_DESCRIPTOR } from './hyper/hyper_connector_descriptor.js';
import { SALESFORCE_CONNECTOR_DESCRIPTOR } from './salesforce/salesforce_connector_descriptor.js';
import { TRINO_CONNECTOR_DESCRIPTOR } from './trino/trino_connector_descriptor.js';

/// The params of the connectors by the field of the connection params that holds them
export interface ConnectorParamsMap {
    /// Direct-to-Hyper connections
    hyper: HyperConnectionParams;
    /// Salesforce Data Cloud connections
    salesforce: SalesforceConnectionParams;
    /// Trino connections
    trino: TrinoConnectionParams;
}
/// The details of the connection state of the connectors
interface ConnectorDetailsMap {
    /// Direct-to-Hyper connections
    hyper: HyperConnectionDetails;
    /// Salesforce Data Cloud connections
    salesforce: SalesforceConnectionStateDetails;
    /// Trino connections
    trino: TrinoConnectionStateDetails;
}
/// The field of the connection params that holds the params of a connector, e.g. `{ hyper: ... }`
export type ConnectorParamsKey = keyof ConnectorParamsMap;

/// What the connection layer knows about a connector.
///
/// Every connector describes itself once, operations on connections look up the connector instead
/// of switching on its type. The params and details of the connection state always hold the params
/// of the connector under its key, generic operations convert between them through `paramsKey`.
export interface ConnectorDescriptor<K extends ConnectorParamsKey = ConnectorParamsKey> {
    /// The connector info
    info: ConnectorInfo;
    /// The field of the connection params that holds the params of the connector
    paramsKey: K;
    /// The variant type of the details of the connection state
    detailsType: ConnectionStateDetailsVariant['type'];
    /// The params of a new connection
    defaultParams(): ConnectorParamsMap[K];
    /// Create the details of the connection state
    createDetails(params: ConnectorParamsMap[K]): ConnectorDetailsMap[K];
    /// Apply an action of the connector to the connection state, null if the action is not one of its own
    reduce(state: ConnectionState, action: ConnectionAction): ConnectionState | null;
    /// Remove the raw form rows, they belong only to the local draft
    withoutDraftRows(params: ConnectorParamsMap[K]): ConnectorParamsMap[K];
    /// Strip the secrets before the params are shared, the login hint only if `withLoginHint` is false
    sanitizeForSharing(params: ConnectorParamsMap[K], withLoginHint: boolean): ConnectorParamsMap[K];
    /// The login hint (the account username or login) of the params, null if there is none
    loginHint(params: ConnectorParamsMap[K]): string | null;
    /// The params that identify the results of a query in the query result cache
    cacheSignature(params: ConnectorParamsMap[K]): unknown;
    /// The database and schema of the relations that unqualified statements create or drop.
    /// They match the names that the catalog loader gives the relations of the connection.
    catalogNameDefaults(details: ConnectorDetailsMap[K]): CatalogNameDefaults;
}

/// The connectors by connector type
export const CONNECTOR_DESCRIPTORS: Record<ConnectorType, ConnectorDescriptor> = {
    [ConnectorType.HYPER]: HYPER_CONNECTOR_DESCRIPTOR,
    [ConnectorType.SALESFORCE_DATA_CLOUD]: SALESFORCE_CONNECTOR_DESCRIPTOR,
    [ConnectorType.TRINO]: TRINO_CONNECTOR_DESCRIPTOR,
};
const DESCRIPTORS = Object.values(CONNECTOR_DESCRIPTORS);

/// The connector of connection params
export function connectorOfParams(params: ConnectionParams): ConnectorDescriptor {
    return DESCRIPTORS.find(connector => connector.paramsKey in params)!;
}

/// The connector of the details of a connection state
export function connectorOfDetails(details: ConnectionStateDetailsVariant): ConnectorDescriptor {
    return DESCRIPTORS.find(connector => connector.detailsType === details.type)!;
}

/// The params of the connector of connection params
export function connectorParams(connector: ConnectorDescriptor, params: ConnectionParams): ConnectorParamsMap[ConnectorParamsKey] {
    return (params as Partial<ConnectorParamsMap>)[connector.paramsKey]!;
}

/// The connection params that hold the params of a connector
export function connectionParamsOf(connector: ConnectorDescriptor, params: ConnectorParamsMap[ConnectorParamsKey]): ConnectionParams {
    return { [connector.paramsKey]: params } as unknown as ConnectionParams;
}

/// The details of a connection state with connection params
export function connectionStateDetailsOf(connector: ConnectorDescriptor, params: ConnectorParamsMap[ConnectorParamsKey]): ConnectionStateDetailsVariant {
    return { type: connector.detailsType, value: connector.createDetails(params) } as ConnectionStateDetailsVariant;
}

/// The database and schema of the relations that unqualified statements create or drop on a connection
export function catalogNameDefaults(details: ConnectionStateDetailsVariant): CatalogNameDefaults {
    return connectorOfDetails(details).catalogNameDefaults(details.value);
}
