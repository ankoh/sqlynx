import * as proto from '@ankoh/sqlynx-protobuf';

import { KeyValueListElement } from '../../view/foundations/keyvalue_list.js';
import { ChannelArgs } from '../../platform/channel_common.js';

export interface TrinoBasicAuthParams {
    /// The username
    username: string;
    /// The secret
    secret: string;
}

export type TrinoAuthParams = TrinoBasicAuthParams;

export interface TrinoConnectionParams {
    /// The endpoint URL
    channelArgs: ChannelArgs;
    /// The auth params
    authParams: TrinoAuthParams;
    /// The gRPC metadata
    metadata: KeyValueListElement[];
}

export function buildTrinoConnectorParams(params: TrinoConnectionParams): proto.sqlynx_workbook.pb.ConnectorParams {
    return new proto.sqlynx_workbook.pb.ConnectorParams({
        connector: {
            case: "trino",
            value: new proto.sqlynx_workbook.pb.TrinoConnectorParams({
                endpoint: params.channelArgs.endpoint ?? "",
                auth: new proto.sqlynx_workbook.pb.TrinoAuthParams({
                    username: params.authParams.username ?? "",
                })
            })
        }
    });
}

