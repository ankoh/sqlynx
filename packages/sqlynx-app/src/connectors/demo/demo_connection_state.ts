import * as arrow from 'apache-arrow';
import * as sqlynx from "@ankoh/sqlynx-core";

import { ConnectionHealth, ConnectionState, ConnectionStateWithoutId, ConnectionStatus, RESET } from "../connection_state.js";
import { CONNECTOR_INFOS, ConnectorType, DEMO_CONNECTOR } from "../connector_info.js";
import { createConnectionState } from "../connection_statistics.js";
import { DemoDatabaseChannel, DemoDatabaseConfig } from "./demo_database_channel.js";
import { VariantKind } from 'utils/variant.js';

const DEFAULT_DATA_FIRST_EVENT = Math.floor((new Date()).getTime() - 1000 * 60 * 60 * 24 * 10);
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
            generateScalarValue: (_row: number) => BigInt(DEFAULT_DATA_FIRST_EVENT + Math.floor(Math.random() * 1000 * 60 * 60))
        },
    ],
    resultBatches: 3,
    resultRowsPerBatch: 200,
    timeMsUntilFirstBatch: 500,
    timeMsBetweenBatches: 50,
};

export interface DemoConnectionParams {
    channel: DemoDatabaseChannel;
}

export function createDemoConnectionState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    const state = createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.DEMO], {
        type: DEMO_CONNECTOR,
        value: {
            channel: new DemoDatabaseChannel(DEFAULT_DEMO_CONFIG)
        }
    });
    state.connectionHealth = ConnectionHealth.ONLINE;
    state.connectionStatus = ConnectionStatus.HEALTH_CHECK_SUCCEEDED;
    return state;
}

export type DemoConnectorAction =
    | VariantKind<typeof RESET, null>
    ;

/// XXX Preparing for a setting page for the demo connector
export function reduceDemoConnectorState(state: ConnectionState, action: DemoConnectorAction): ConnectionState | null {
    let next: ConnectionState | null = null;
    switch (action.type) {
        case RESET:
            next = {
                ...state,
                details: {
                    type: DEMO_CONNECTOR,
                    value: {
                        channel: new DemoDatabaseChannel(DEFAULT_DEMO_CONFIG)
                    }
                }
            };
            break;
    }
    return next;
}
