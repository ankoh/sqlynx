import * as pb from '@ankoh/dashql-protobuf';

import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

export interface ServerlessConnectionParams { }

export function encodeServerlessConnectionParamsAsProto(_settings: WorkbookExportSettings | null): pb.dashql.connection.ConnectionParams {
    return new pb.dashql.connection.ConnectionParams({
        connection: {
            case: "serverless",
            value: new pb.dashql.connection.ServerlessParams()
        }
    });
}

export function readServerlessConnectionParamsFromProto(_params: pb.dashql.connection.ServerlessParams): ServerlessConnectionParams {
    return {};
}

