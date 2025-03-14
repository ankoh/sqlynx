import * as proto from '@ankoh/sqlynx-protobuf';

import { KeyValueListElement } from '../../view/foundations/keyvalue_list.js';
import { ChannelArgs } from '../../platform/channel_common.js';
import { ValueListElement } from '../../view/foundations/value_list.js';

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
    /// The catalog name
    catalogName: string;
    /// The schema names
    schemaNames: ValueListElement[];
}

export function buildTrinoConnectionParams(params: TrinoConnectionParams): proto.sqlynx_connection.pb.ConnectionParams {
    return new proto.sqlynx_connection.pb.ConnectionParams({
        connection: {
            case: "trino",
            value: new proto.sqlynx_connection.pb.TrinoConnectionParams({
                endpoint: params.channelArgs.endpoint ?? "",
                auth: new proto.sqlynx_connection.pb.TrinoAuthParams({
                    username: params.authParams.username ?? "",
                }),
                catalogName: params.catalogName,
                schemaNames: params.schemaNames,
            })
        }
    });
}

export function readTrinoConnectionParams(params: proto.sqlynx_connection.pb.TrinoConnectionParams): TrinoConnectionParams {
    return {
        channelArgs: {
            endpoint: params.endpoint
        },
        authParams: {
            username: params.auth?.username ?? "",
            secret: "",
        },
        metadata: [],
        catalogName: params.catalogName,
        schemaNames: params.schemaNames,
    };
}

