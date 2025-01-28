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

export function buildHyperConnectorParams(params: HyperGrpcConnectionParams): proto.sqlynx_session.pb.ConnectorParams {
    const tls = new proto.sqlynx_session.pb.TlsConfig({
        clientKeyPath: params.channelArgs.tls?.keyPath,
        clientCertPath: params.channelArgs.tls?.pubPath,
        caCertsPath: params.channelArgs.tls?.caPath,
    });
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "hyper",
            value: new proto.sqlynx_session.pb.HyperConnectorParams({
                endpoint: params.channelArgs.endpoint ?? "",
                tls
            })
        }
    });
}

