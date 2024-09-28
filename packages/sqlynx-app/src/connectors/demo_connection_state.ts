import * as arrow from 'apache-arrow';
import * as sqlynx from "@ankoh/sqlynx-core";

import { ConnectionStateWithoutId } from "./connection_state.js";
import { CONNECTOR_INFOS, ConnectorType, DEMO_CONNECTOR } from "./connector_info.js";
import { createConnectionState } from "./connection_statistics.js";
import { DemoDatabaseChannel, DemoDatabaseConfig } from "./demo_database.js";

const DEFAULT_DATA_FIRST_EVENT = (new Date()).getTime() - 1000 * 60 * 60 * 24 * 10;
const DEFAULT_DEMO_CONFIG: DemoDatabaseConfig = {
    fields: [
        {
            name: "RecordId__c",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => crypto.randomUUID()
        },
        {
            name: "SourceRecordId__c",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => crypto.randomUUID()
        },
        {
            name: "EventTime",
            type: new arrow.TimestampMillisecond(),
            nullable: true,
            generateScalarValue: (_row: number) => DEFAULT_DATA_FIRST_EVENT + (Math.random() * 1000 * 60 * 60)
        },
    ],
    resultBatches: 3,
    resultRowsPerBatch: 200,
    timeMsUntilFirstBatch: 1000,
    timeMsBetweenBatches: 50,
};

export interface DemoConnectionDetails {
    channel: DemoDatabaseChannel;
}

export function createDemoConnectionState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    return createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.DEMO], {
        type: DEMO_CONNECTOR,
        value: {
            channel: new DemoDatabaseChannel(DEFAULT_DEMO_CONFIG)
        }
    });
}
