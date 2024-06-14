import * as sqlynx from '@ankoh/sqlynx-core';
import * as arrow from 'apache-arrow';

import {
    HyperGrpcConnectionDetails,
    HyperGrpcConnectorAction,
    reduceHyperGrpcConnectorState,
} from './hyper_grpc_connection_state.js';
import {
    reduceSalesforceConnectionState,
    SalesforceConnectionDetails,
    SalesforceConnectionStateAction,
} from './salesforce_connection_state.js';
import { CatalogUpdateRequestVariant, CatalogUpdateTaskState } from './catalog_update.js';
import { VariantKind } from '../utils/variant.js';
import { HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR } from './connector_info.js';
import { QueryExecutionProgress, QueryExecutionResponseStream, QueryExecutionTaskState } from './query_execution.js';

export interface ConnectionState {
    /// The connection id
    connectionId: number;
    /// The connection state
    connectionStatus: ConnectionStatus;
    /// The connection health
    connectionHealth: ConnectionHealth;
    /// The connection statistics
    stats: ConnectionStatistics;

    /// The connection details
    details: ConnectionDetailsVariant;

    /// The catalog
    catalog: sqlynx.SQLynxCatalog | null;
    /// The pending catalog updates
    catalogUpdatesQueued: Map<number, CatalogUpdateRequestVariant>;
    /// The catalog updates that are currently running
    catalogUpdatesRunning: Map<number, CatalogUpdateTaskState>;
    /// The catalog updates that are currently running
    catalogUpdatesFinished: Map<number, CatalogUpdateTaskState>;

    /// The queries that are queued
    queriesQueued: Map<number, QueryExecutionTaskState>;
    /// The queries that are currently running
    queriesRunning: Map<number, QueryExecutionTaskState>;
    /// The queries that finished (succeeded, failed, cancelled)
    queriesFinished: Map<number, QueryExecutionTaskState>;
}

export type ConnectionDetailsVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectionDetails>
    | VariantKind<typeof SERVERLESS_CONNECTOR, unknown>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcConnectionDetails>
    ;

export interface ConnectionStatistics {
    totalQueriesStarted: bigint;
    totalQueriesFinished: bigint;
    totalQueryDurationMs: bigint;
    lastQueryStarted: Date | null;
    lastQueryFinished: Date | null;
}

export function createConnectionStatistics(): ConnectionStatistics {
    return {
        totalQueriesStarted: BigInt(0),
        totalQueriesFinished: BigInt(0),
        totalQueryDurationMs: BigInt(0),
        lastQueryStarted: null,
        lastQueryFinished: null
    };
}

export enum ConnectionStatus {
    NOT_STARTED,

    // Generate setup status
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_SUCCEEDED,

    // Hyper gRPC setup status
    CHANNEL_SETUP_STARTED,
    CHANNEL_SETUP_FAILED,
    CHANNEL_SETUP_CANCELLED,
    CHANNEL_READY,

    // Salesforce setup status
    AUTH_STARTED,
    AUTH_CANCELLED,
    AUTH_FAILED,
    PKCE_GENERATION_STARTED,
    PKCE_GENERATED,
    WAITING_FOR_OAUTH_CODE_VIA_WINDOW,
    WAITING_FOR_OAUTH_CODE_VIA_LINK,
    OAUTH_CODE_RECEIVED,
    DATA_CLOUD_TOKEN_REQUESTED,
    DATA_CLOUD_TOKEN_RECEIVED,
    CORE_ACCESS_TOKEN_REQUESTED,
    CORE_ACCESS_TOKEN_RECEIVED,
}

export enum ConnectionHealth {
    NOT_STARTED,
    CONNECTING,
    CANCELLED,
    ONLINE,
    FAILED,
}


export type ConnectionStateWithoutId = Omit<ConnectionState, "connectionId">;

export function createConnectionState(details: ConnectionDetailsVariant): ConnectionStateWithoutId {
    return {
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        stats: createConnectionStatistics(),
        details,
        catalog: null,
        catalogUpdatesQueued: new Map(),
        catalogUpdatesRunning: new Map(),
        catalogUpdatesFinished: new Map(),
        queriesQueued: new Map(),
        queriesRunning: new Map(),
        queriesFinished: new Map(),
    };
}

export const RESET = Symbol('RESET');
export const UPDATE_CATALOG = Symbol('UPDATE_CATALOG');
export const CATALOG_UPDATE_STARTED = Symbol('CATALOG_UPDATE_STARTED');
export const CATALOG_UPDATE_SUCCEEDED = Symbol('CATALOG_UPDATE_SUCCEEDED');
export const CATALOG_UPDATE_FAILED = Symbol('CATALOG_UPDATE_FAILED');
export const CATALOG_UPDATE_CANCELLED = Symbol('CATALOG_UPDATE_CANCELLED');

export const EXECUTE_QUERY = Symbol('EXECUTE_QUERY');
export const QUERY_EXECUTION_ACCEPTED = Symbol('QUERY_EXECUTION_ACCEPTED');
export const QUERY_EXECUTION_STARTED = Symbol('QUERY_EXECUTION_STARTED');
export const QUERY_EXECUTION_PROGRESS_UPDATED = Symbol('QUERY_EXECUTION_PROGRESS_UPDATED');
export const QUERY_EXECUTION_RECEIVED_SCHEMA = Symbol('QUERY_EXECUTION_RECEIVED_SCHEMA');
export const QUERY_EXECUTION_RECEIVED_BATCH = Symbol('QUERY_EXECUTION_RECEIVED_BATCH');
export const QUERY_EXECUTION_SUCCEEDED = Symbol('QUERY_EXECUTION_SUCCEEDED');
export const QUERY_EXECUTION_FAILED = Symbol('QUERY_EXECUTION_FAILED');
export const QUERY_EXECUTION_CANCELLED = Symbol('QUERY_EXECUTION_CANCELLED');

export type ConnectionStateBaseAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof UPDATE_CATALOG, CatalogUpdateRequestVariant>
    | VariantKind<typeof CATALOG_UPDATE_STARTED, CatalogUpdateTaskState[]>
    | VariantKind<typeof CATALOG_UPDATE_CANCELLED, number>
    | VariantKind<typeof CATALOG_UPDATE_SUCCEEDED, number>
    | VariantKind<typeof CATALOG_UPDATE_FAILED, [number, any]>
    | VariantKind<typeof EXECUTE_QUERY, null>
    | VariantKind<typeof QUERY_EXECUTION_ACCEPTED, QueryExecutionTaskState>
    | VariantKind<typeof QUERY_EXECUTION_STARTED, QueryExecutionResponseStream>
    | VariantKind<typeof QUERY_EXECUTION_PROGRESS_UPDATED, QueryExecutionProgress>
    | VariantKind<typeof QUERY_EXECUTION_RECEIVED_SCHEMA, arrow.Schema>
    | VariantKind<typeof QUERY_EXECUTION_RECEIVED_BATCH, arrow.RecordBatch>
    | VariantKind<typeof QUERY_EXECUTION_SUCCEEDED, arrow.RecordBatch | null>
    | VariantKind<typeof QUERY_EXECUTION_FAILED, any>
    | VariantKind<typeof QUERY_EXECUTION_CANCELLED, null>

export type ConnectionStateAction = ConnectionStateBaseAction | HyperGrpcConnectorAction | SalesforceConnectionStateAction;

export function reduceConnectionState(state: ConnectionState, action: ConnectionStateAction): ConnectionState {
    switch (action.type) {
        case UPDATE_CATALOG:
        case CATALOG_UPDATE_STARTED:
        case CATALOG_UPDATE_CANCELLED:
        case CATALOG_UPDATE_SUCCEEDED:
        case CATALOG_UPDATE_FAILED:
        case EXECUTE_QUERY:
        case QUERY_EXECUTION_ACCEPTED:
        case QUERY_EXECUTION_STARTED:
        case QUERY_EXECUTION_PROGRESS_UPDATED:
        case QUERY_EXECUTION_RECEIVED_SCHEMA:
        case QUERY_EXECUTION_RECEIVED_BATCH:
        case QUERY_EXECUTION_SUCCEEDED:
        case QUERY_EXECUTION_CANCELLED:
        case QUERY_EXECUTION_FAILED:
            return state;

        // RESET is a bit special since we want to clean up our details as well
        case RESET: {
            // XXX Cleanup query executions and catalog
            const cleaned: ConnectionState = state;

            // Cleanup the details
            let details: ConnectionState | null = null;
            switch (state.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    details = reduceSalesforceConnectionState(cleaned, action as SalesforceConnectionStateAction);
                    break;
                case HYPER_GRPC_CONNECTOR:
                    details = reduceHyperGrpcConnectorState(cleaned, action as HyperGrpcConnectorAction);
                    break;
                case SERVERLESS_CONNECTOR:
                    break;
            }

            // Cleaning up details is best-effort. No need to check if RESET was actually consumed
            return details ?? cleaned;
        }

        default: {
            let next: ConnectionState | null = null;
            switch (state.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    next = reduceSalesforceConnectionState(state, action as SalesforceConnectionStateAction);
                    break;
                case HYPER_GRPC_CONNECTOR:
                    next = reduceHyperGrpcConnectorState(state, action as HyperGrpcConnectorAction);
                    break;
                case SERVERLESS_CONNECTOR:
                    break;
            }
            if (next == null) {
                throw new Error(`failed to apply state action: ${String(action.type)}`);
            }
            return next;
        }
    }
}