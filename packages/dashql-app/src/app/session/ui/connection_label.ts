import type { ConnectionState } from '../../connections/connection_state.js';
import { HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR } from '../../connections/connector_info.js';
import { getConnectionInfoFromParams, type ConnectionParams } from '../../connections/connection_params.js';

export function isHyperWasmConnection(database: ConnectionState): boolean {
    return database.details.type === HYPER_CONNECTOR &&
        (database.details.value.proto.setupParams?.protocol ?? 'WASM') === 'WASM';
}

export function connectionLabel(database: ConnectionState): string {
    if (isHyperWasmConnection(database)) return 'Memory';
    let protocol = 'HTTP';
    if (database.details.type === HYPER_CONNECTOR) {
        const value = database.details.value.proto.setupParams?.protocol;
        protocol = value === 'V3_GRPC' ? 'gRPC'
                : value === 'V3_HTTP' ? 'HTTP'
                    : 'WASM';
    } else if (database.details.type === SALESFORCE_DATA_CLOUD_CONNECTOR) {
        const value = database.details.value.proto.setupParams?.hyperProtocol;
        protocol = value === 'V3_GRPC' ? 'gRPC' : value === 'WASM' ? 'WASM' : 'HTTP';
    }
    return `${database.connectorInfo.names.displayLong} / ${protocol}`;
}

/// A label for connection params, e.g. when the connection state is not restored
export function connectionParamsLabel(params: ConnectionParams): string {
    const name = getConnectionInfoFromParams(params)?.names.displayLong ?? 'Connection';
    if ('hyper' in params) {
        const protocol = params.hyper.protocol ?? 'WASM';
        return protocol === 'WASM' ? `${name} / Memory` : `${name} / ${params.hyper.endpoint ?? ''}`;
    }
    if ('trino' in params) return `${name} / ${params.trino.endpoint ?? ''}`;
    if ('salesforce' in params) return `${name} / ${params.salesforce.instanceUrl ?? ''}`;
    return name;
}
