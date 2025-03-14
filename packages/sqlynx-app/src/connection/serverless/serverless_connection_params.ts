import * as proto from '@ankoh/sqlynx-protobuf';

import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

export function buildServerlessConnectionParams(_settings: WorkbookExportSettings | null): proto.sqlynx_connection.pb.ConnectionParams {
    return new proto.sqlynx_connection.pb.ConnectionParams({
        connection: {
            case: "serverless",
            value: new proto.sqlynx_connection.pb.ServerlessParams()
        }
    });
}
