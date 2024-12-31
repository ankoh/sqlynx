import * as arrow from 'apache-arrow';
import * as sqlynx from "@ankoh/sqlynx-core";

import { ConnectionHealth, ConnectionState, ConnectionStateWithoutId, ConnectionStatus, RESET } from "../connection_state.js";
import { CONNECTOR_INFOS, ConnectorType, DEMO_CONNECTOR } from "../connector_info.js";
import { createConnectionState } from "../connection_statistics.js";
import { DemoDatabaseChannel, DemoDatabaseConfig } from "./demo_database_channel.js";
import { VariantKind } from '../../utils/variant.js';
import { Int128 } from '../../utils/int128.js';

const DEFAULT_DATA_FIRST_EVENT = Math.floor((new Date()).getTime() - 1000 * 60 * 60 * 24 * 10);
const DEFAULT_DEMO_CONFIG: DemoDatabaseConfig = {
    fields: [
        {
            name: "Text/Random",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => crypto.randomUUID()
        },
        {
            name: "Text/10",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => `LongRandomText/${Math.floor(Math.random() * 10)}`
        },
        {
            name: "Text/2",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => `BinaryText/${Math.floor(Math.random() * 2)}`
        },
        {
            name: "Text/2/Nulls",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => Math.random() < 0.3 ? null : `NullableText/${Math.floor(Math.random() * 2)}`
        },
        {
            name: "EventTime",
            type: new arrow.TimestampMillisecond(),
            nullable: true,
            generateScalarValue: (row: number) => BigInt(DEFAULT_DATA_FIRST_EVENT + Math.floor(row * 1000 * 60 * 60 + Math.random() * 1000 * 60 * 60))
        },
        {
            name: "Score1",
            type: new arrow.Decimal(18, 38, 128),
            nullable: true,
            generateScalarValue: (row: number) => {
                const intPart = BigInt(row) * BigInt(1e18);
                const fractionPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e14);
                return Int128.encodeLE(intPart + fractionPart);
            }
        },
        {
            name: "Score2",
            type: new arrow.Decimal(18, 38, 128),
            nullable: true,
            generateScalarValue: (_row: number) => {
                if (Math.random() < 0.2) {
                    return null;
                } else {
                    const intPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e18);
                    const fractionPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e14);
                    return Int128.encodeLE(intPart + fractionPart);
                }
            }
        },
        {
            name: "Score3",
            type: new arrow.Decimal(18, 38, 128),
            nullable: false,
            generateScalarValue: (_row: number) => {
                const intPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e18);
                return Int128.encodeLE(intPart);
            }
        },
        {
            name: "Float32",
            type: new arrow.Float32(),
            nullable: false,
            generateScalarValue: (_row: number) => {
                const value = Math.random();
                return value;
            }
        },
        {
            name: "List/Float32",
            type: new arrow.List(new arrow.Field(
                "element",
                new arrow.Float32(),
                false
            )),
            nullable: false,
            listElement: {
                name: "List/Float32/Element",
                type: new arrow.Float32(),
                nullable: false,
                generateScalarValue: (_row: number) => {
                    const value = Math.random();
                    return value;
                }
            },
            listLength: (_row: number) => 1024,
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
