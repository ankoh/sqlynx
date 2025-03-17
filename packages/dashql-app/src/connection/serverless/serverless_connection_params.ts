import * as proto from '@ankoh/dashql-protobuf';

import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

export interface ServerlessConnectionParams { }

export function encodeServerlessConnectionParamsAsProto(_settings: WorkbookExportSettings | null): proto.dashql_connection.pb.ConnectionParams {
    return new proto.dashql_connection.pb.ConnectionParams({
        connection: {
            case: "serverless",
            value: new proto.dashql_connection.pb.ServerlessParams()
        }
    });
}

export function readServerlessConnectionParamsFromProto(_params: proto.dashql_connection.pb.ServerlessParams): ServerlessConnectionParams {
    return {};
}

