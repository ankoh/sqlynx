import type { ConnectionState } from '../connection_state.js';
import { isListedConnection, type ConnectionReferences, type ConnectionRegistry } from '../connection_registry.js';
import { getConnectorInfoForParams, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR } from '../connector_info.js';
import type { ConnectionParams } from '../connection_params.js';

export function isHyperWasmConnection(database: ConnectionState): boolean {
    return database.details.type === HYPER_CONNECTOR &&
        (database.details.value.proto.setupParams?.protocol ?? 'WASM') === 'WASM';
}

/// Does a connection offer an operational overview?
export function supportsConnectionOverview(database: ConnectionState): boolean {
    return database.details.type === HYPER_CONNECTOR;
}

/// The label of a connection, its name and the protocol it speaks
export interface ConnectionLabelParts {
    /// The name of the connection, e.g. "Hyper" or "Hyper #2"
    name: string;
    /// The name of the connector, e.g. "Hyper"
    connector: string;
    /// The protocol, e.g. "Local" or "Http"
    detail: string;
}

/// The protocol of a connection as the label shows it
function protocolLabel(protocol: string | undefined): string {
    return protocol === 'V3_GRPC' ? 'gRPC' : protocol === 'V3_HTTP' ? 'Http' : 'Local';
}

/// The parts of the label of a connection.
/// A connection is called after its connector, the ordinal tells it apart from other connections
/// of the same connector, see `connectionOrdinals`.
export function connectionLabelParts(database: ConnectionState, ordinal: number | null = null): ConnectionLabelParts {
    let detail = 'Http';
    if (database.details.type === HYPER_CONNECTOR) {
        detail = protocolLabel(database.details.value.proto.setupParams?.protocol ?? 'WASM');
    } else if (database.details.type === SALESFORCE_DATA_CLOUD_CONNECTOR) {
        detail = protocolLabel(database.details.value.proto.setupParams?.hyperProtocol ?? 'V3_HTTP');
    }
    const connector = database.connectorInfo.names.displayLong;
    return { name: ordinal == null ? connector : `${connector} #${ordinal}`, connector, detail };
}

/// The label of a connection as plain text, e.g. "Hyper #2 Local"
export function connectionLabel(database: ConnectionState, ordinal: number | null = null): string {
    return connectionLabelText(connectionLabelParts(database, ordinal));
}

/// The plain text of the parts of a label
export function connectionLabelText(parts: ConnectionLabelParts): string {
    return `${parts.name} ${parts.detail}`;
}

/// The ordinals of the connections that share their connector with other connections, 1-based in
/// registration order. Only listed connections are numbered, see `isListedConnection`, so the
/// numbers don't depend on the current session.
export function connectionOrdinals(
    registry: Pick<ConnectionRegistry, 'connections' | 'connectionsByType'>,
    references: ConnectionReferences,
): Map<string, number> {
    const ordinals = new Map<string, number>();
    for (const connectionIds of registry.connectionsByType) {
        const listed = connectionIds.filter(connectionId => isListedConnection(registry, references, connectionId));
        if (listed.length < 2) continue;
        listed.forEach((connectionId, index) => ordinals.set(connectionId, index + 1));
    }
    return ordinals;
}

/// A label for connection params, e.g. when the connection state is not restored.
/// It names the connector and the location of the database that the params describe.
export function connectionParamsLabel(params: ConnectionParams): string {
    const name = getConnectorInfoForParams(params)?.names.displayLong ?? 'Connection';
    if ('hyper' in params) {
        const protocol = params.hyper.protocol ?? 'WASM';
        return protocol === 'WASM' ? `${name} Local` : `${name} / ${params.hyper.endpoint ?? ''}`;
    }
    if ('trino' in params) return `${name} / ${params.trino.endpoint ?? ''}`;
    if ('salesforce' in params) return `${name} / ${params.salesforce.instanceUrl ?? ''}`;
    return name;
}
