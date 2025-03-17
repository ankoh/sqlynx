import * as proto from '@ankoh/dashql-protobuf';

import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';
import { DemoConnectionParams } from './demo_connection_state.js';
import { DemoDatabaseChannel } from './demo_database_channel.js';

export function encodeDemoConnectionParamsAsProto(_settings: WorkbookExportSettings | null): proto.dashql_connection.pb.ConnectionParams {
    return new proto.dashql_connection.pb.ConnectionParams({
        connection: {
            case: "demo",
            value: new proto.dashql_connection.pb.DemoParams()
        }
    });
}

export function readDemoConnectionParamsFromProto(_params: proto.dashql_connection.pb.DemoParams): DemoConnectionParams {
    return {
        channel: new DemoDatabaseChannel(),
    };
}

