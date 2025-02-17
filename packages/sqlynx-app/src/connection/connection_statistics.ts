import * as sqlynx from '@ankoh/sqlynx-core';

import { ConnectorInfo } from './connector_info.js';
import {
    ConnectionDetailsVariant, ConnectionHealth,
    ConnectionStateWithoutId,
    ConnectionStatus,
} from './connection_state.js';

export interface ConnectionQueryMetrics {
    totalQueries: bigint;
    totalBatchesReceived: bigint;
    totalRowsReceived: bigint;
    accumulatedTimeUntilSchemaMs: bigint;
    accumulatedTimeUntilFirstBatchMs: bigint;
    accumulatedQueryDurationMs: bigint;
}

export interface ConnectionMetrics {
    successfulQueries: ConnectionQueryMetrics;
    canceledQueries: ConnectionQueryMetrics;
    failedQueries: ConnectionQueryMetrics;
}

export function createConnectionQueryStatistics(): ConnectionQueryMetrics {
    return {
        totalQueries: BigInt(0),
        totalBatchesReceived: BigInt(0),
        totalRowsReceived: BigInt(0),
        accumulatedTimeUntilSchemaMs: BigInt(0),
        accumulatedTimeUntilFirstBatchMs: BigInt(0),
        accumulatedQueryDurationMs: BigInt(0)
    };
}

export function createConnectionMetrics(): ConnectionMetrics {
    return {
        successfulQueries: createConnectionQueryStatistics(),
        canceledQueries: createConnectionQueryStatistics(),
        failedQueries: createConnectionQueryStatistics(),
    };
}

export function createConnectionState(lnx: sqlynx.SQLynx, info: ConnectorInfo, details: ConnectionDetailsVariant): ConnectionStateWithoutId {
    const catalog = lnx.createCatalog();
    return {
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectorInfo: info,
        metrics: createConnectionMetrics(),
        details,
        catalog,
        catalogUpdatesRunning: new Map(),
        catalogUpdatesFinished: [],
        queriesRunning: new Map(),
        queriesFinished: new Map(),
    };
}
