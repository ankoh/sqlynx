import * as pb from '@ankoh/dashql-protobuf';

import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';
import { DemoConnectionParams } from './demo_connection_state.js';
import { DemoDatabaseChannel } from './demo_database_channel.js';

export function encodeDemoConnectionParamsAsProto(_settings: WorkbookExportSettings | null): pb.dashql.connection.ConnectionParams {
    return new pb.dashql.connection.ConnectionParams({
        connection: {
            case: "demo",
            value: new pb.dashql.connection.DemoParams()
        }
    });
}

export function readDemoConnectionParamsFromProto(_params: pb.dashql.connection.DemoParams): DemoConnectionParams {
    return {
        channel: new DemoDatabaseChannel(),
    };
}

