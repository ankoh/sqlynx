import type { ConnectionState } from '../connection_state.js';
import { HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR } from '../connector_info.js';
import { getConnectionInfoFromParams, type ConnectionParams } from '../connection_params.js';

export function isHyperWasmConnection(database: ConnectionState): boolean {
    return database.details.type === HYPER_CONNECTOR &&
        (database.details.value.proto.setupParams?.protocol ?? 'WASM') === 'WASM';
}

/// The label of a connection, the connector and the protocol it speaks
export interface ConnectionLabelParts {
    /// The name of the connector, e.g. "Hyper"
    name: string;
    /// The protocol, e.g. "Local" or "Http"
    detail: string;
}

/// The protocol of a connection as the label shows it
function protocolLabel(protocol: string | undefined): string {
    return protocol === 'V3_GRPC' ? 'gRPC' : protocol === 'V3_HTTP' ? 'Http' : 'Local';
}

/// The parts of the label of a connection
export function connectionLabelParts(database: ConnectionState): ConnectionLabelParts {
    let detail = 'Http';
    if (database.details.type === HYPER_CONNECTOR) {
        detail = protocolLabel(database.details.value.proto.setupParams?.protocol ?? 'WASM');
    } else if (database.details.type === SALESFORCE_DATA_CLOUD_CONNECTOR) {
        detail = protocolLabel(database.details.value.proto.setupParams?.hyperProtocol ?? 'V3_HTTP');
    }
    return { name: database.connectorInfo.names.displayLong, detail };
}

/// The label of a connection as plain text, e.g. "Hyper Local"
export function connectionLabel(database: ConnectionState): string {
    const { name, detail } = connectionLabelParts(database);
    return `${name} ${detail}`;
}

/// A label for connection params, e.g. when the connection state is not restored
export function connectionParamsLabel(params: ConnectionParams): string {
    const name = getConnectionInfoFromParams(params)?.names.displayLong ?? 'Connection';
    if ('hyper' in params) {
        const protocol = params.hyper.protocol ?? 'WASM';
        return protocol === 'WASM' ? `${name} Local` : `${name} / ${params.hyper.endpoint ?? ''}`;
    }
    if ('trino' in params) return `${name} / ${params.trino.endpoint ?? ''}`;
    if ('salesforce' in params) return `${name} / ${params.salesforce.instanceUrl ?? ''}`;
    return name;
}
