import * as sqlynx from "@ankoh/sqlynx-core";

import { ConnectionStateWithoutId } from "./connection_state.js";
import { CONNECTOR_INFOS, ConnectorType, DEMO_CONNECTOR } from "./connector_info.js";
import { createConnectionState } from "./connection_statistics.js";
// import { DemoDatabaseChannel } from "./demo_database.js";

export interface DemoConnectionDetails {
    // channel: DemoDatabaseChannel;
}

export function createDemoConnectionState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    return createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.DEMO], {
        type: DEMO_CONNECTOR,
        value: {
        }
    });
}
