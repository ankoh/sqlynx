import * as pb from '@ankoh/dashql-protobuf';

import { KeyValueListElement } from '../../view/foundations/keyvalue_list.js';
import { ChannelArgs } from '../../platform/channel_common.js';
import { ValueListElement } from '../../view/foundations/value_list.js';
import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

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

export function encodeTrinoConnectionParamsAsProto(params: TrinoConnectionParams, _settings: WorkbookExportSettings | null): pb.dashql.connection.ConnectionParams {
    return new pb.dashql.connection.ConnectionParams({
        connection: {
            case: "trino",
            value: new pb.dashql.connection.TrinoConnectionParams({
                endpoint: params.channelArgs.endpoint ?? "",
                auth: new pb.dashql.connection.TrinoAuthParams({
                    username: params.authParams.username ?? "",
                }),
                catalogName: params.catalogName,
                schemaNames: params.schemaNames,
            })
        }
    });
}

export function readTrinoConnectionParamsFromProto(params: pb.dashql.connection.TrinoConnectionParams): TrinoConnectionParams {
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

