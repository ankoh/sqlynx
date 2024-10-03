import * as proto from '@ankoh/sqlynx-protobuf';

import { GrpcChannelArgs } from "../../platform/grpc_common.js";
import { KeyValueListElement } from "../../view/foundations/keyvalue_list.js";

export interface HyperGrpcConnectionParams {
    /// The gRPC endpoint
    channel: GrpcChannelArgs;
    /// The attached databases
    attachedDatabases: KeyValueListElement[];
    /// The gRPC metadata
    gRPCMetadata: KeyValueListElement[];
}

export function buildHyperConnectorParams(params: HyperGrpcConnectionParams): proto.sqlynx_session.pb.ConnectorParams {
    const tls = new proto.sqlynx_session.pb.TlsConfig({
        clientKeyPath: params.channel.tls?.keyPath,
        clientCertPath: params.channel.tls?.pubPath,
        caCertsPath: params.channel.tls?.caPath,
    });
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "hyper",
            value: new proto.sqlynx_session.pb.HyperConnectorParams({
                endpoint: params.channel.endpoint ?? "",
                tls
            })
        }
    });
}

