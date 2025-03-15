import * as proto from '@ankoh/dashql-protobuf';

import { ChannelArgs } from "../../platform/channel_common.js";
import { KeyValueListElement } from "../../view/foundations/keyvalue_list.js";
import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

export interface HyperGrpcConnectionParams {
    /// The gRPC endpoint
    channelArgs: ChannelArgs;
    /// The attached databases
    attachedDatabases: KeyValueListElement[];
    /// The gRPC metadata
    gRPCMetadata: KeyValueListElement[];
}

export function buildHyperConnectionParams(params: HyperGrpcConnectionParams, _settings: WorkbookExportSettings | null): proto.dashql_connection.pb.ConnectionParams {
    const tls = new proto.dashql_connection.pb.TlsConfig({
        clientKeyPath: params.channelArgs.tls?.keyPath,
        clientCertPath: params.channelArgs.tls?.pubPath,
        caCertsPath: params.channelArgs.tls?.caPath,
    });
    return new proto.dashql_connection.pb.ConnectionParams({
        connection: {
            case: "hyper",
            value: new proto.dashql_connection.pb.HyperConnectionParams({
                endpoint: params.channelArgs.endpoint ?? "",
                tls
            })
        }
    });
}


export function readHyperConnectionParams(params: proto.dashql_connection.pb.HyperConnectionParams): HyperGrpcConnectionParams {
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

