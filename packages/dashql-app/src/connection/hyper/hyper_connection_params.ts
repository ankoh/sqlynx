import * as pb from '@ankoh/dashql-protobuf';

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

export function encodeHyperConnectionParamsAsProto(params: HyperGrpcConnectionParams, _settings: WorkbookExportSettings | null): pb.dashql.connection.ConnectionParams {
    const tls = new pb.dashql.connection.TlsConfig({
        clientKeyPath: params.channelArgs.tls?.keyPath,
        clientCertPath: params.channelArgs.tls?.pubPath,
        caCertsPath: params.channelArgs.tls?.caPath,
    });
    return new pb.dashql.connection.ConnectionParams({
        connection: {
            case: "hyper",
            value: new pb.dashql.connection.HyperConnectionParams({
                endpoint: params.channelArgs.endpoint ?? "",
                tls
            })
        }
    });
}

export function readHyperConnectionParamsFromProto(params: pb.dashql.connection.HyperConnectionParams): HyperGrpcConnectionParams {
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

