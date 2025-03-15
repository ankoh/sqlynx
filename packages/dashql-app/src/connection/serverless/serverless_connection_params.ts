import * as proto from '@ankoh/dashql-protobuf';

import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

export function buildServerlessConnectionParams(_settings: WorkbookExportSettings | null): proto.dashql_connection.pb.ConnectionParams {
    return new proto.dashql_connection.pb.ConnectionParams({
        connection: {
            case: "serverless",
            value: new proto.dashql_connection.pb.ServerlessParams()
        }
    });
}
