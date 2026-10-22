import type { HyperConnectionParams } from '../connection_params.js';

export function createHyperConnectionParamsSignature(params: HyperConnectionParams): any {
    return {
        case: "hyper",
        protocol: params.protocol,
        channelArgs: {
            endpoint: params.endpoint,
            tls: params.tls
        },
        attachedDatabases: (params.attachedDatabases || [])
            .map((d: any) => ({ path: d.path, alias: d.alias }))
            .sort((a: any, b: any) => a.path > b.path ? 1 : -1),
        gRPCMetadata: params.metadata ? Object.entries(params.metadata).sort(([a,], [b]) => a > b ? 1 : -1) : [],
        queryParameters: params.queryParameters ? Object.entries(params.queryParameters).sort(([a,], [b]) => a > b ? 1 : -1) : []
    };
}
