import * as proto from '@ankoh/sqlynx-protobuf';

import { ChannelArgs } from "../../platform/channel_common.js";
import { KeyValueListElement } from "../../view/foundations/keyvalue_list.js";

export interface HyperGrpcConnectionParams {
    /// The gRPC endpoint
    channelArgs: ChannelArgs;
    /// The attached databases
    attachedDatabases: KeyValueListElement[];
    /// The gRPC metadata
    gRPCMetadata: KeyValueListElement[];
}

export function buildHyperConnectorParams(params: HyperGrpcConnectionParams): proto.sqlynx_workbook.pb.ConnectorParams {
    const tls = new proto.sqlynx_workbook.pb.TlsConfig({
        clientKeyPath: params.channelArgs.tls?.keyPath,
        clientCertPath: params.channelArgs.tls?.pubPath,
        caCertsPath: params.channelArgs.tls?.caPath,
    });
    return new proto.sqlynx_workbook.pb.ConnectorParams({
        connector: {
            case: "hyper",
            value: new proto.sqlynx_workbook.pb.HyperConnectorParams({
                endpoint: params.channelArgs.endpoint ?? "",
                tls
            })
        }
    });
}


export function readHyperConnectorParams(params: proto.sqlynx_workbook.pb.HyperConnectorParams): HyperGrpcConnectionParams {
    const metadata = [];
    for (const k in params.metadata) {
        metadata.push({
            key: k,
            value: params.metadata[k]
        })
    }
    return {
        channelArgs: {
            endpoint: params.endpoint,
        },
        attachedDatabases: params.attachedDatabases.map((a) => ({ key: a.path, value: a.alias })),
        gRPCMetadata: metadata
    };
}

