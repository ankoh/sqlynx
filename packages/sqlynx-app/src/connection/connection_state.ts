import * as sqlynx from '@ankoh/sqlynx-core';
import * as arrow from 'apache-arrow';

import {
    HyperGrpcConnectionDetails,
    HyperGrpcConnectorAction,
    reduceHyperGrpcConnectorState,
} from './hyper/hyper_connection_state.js';
import {
    reduceSalesforceConnectionState,
    SalesforceConnectionDetails,
    SalesforceConnectionStateAction,
} from './salesforce/salesforce_connection_state.js';
import { CatalogUpdateTaskState, reduceCatalogAction } from './catalog_update_state.js';
import { VariantKind } from '../utils/variant.js';
import {
    CONNECTOR_INFOS,
    ConnectorInfo,
    ConnectorType,
    DEMO_CONNECTOR,
    HYPER_GRPC_CONNECTOR,
    SALESFORCE_DATA_CLOUD_CONNECTOR,
    SERVERLESS_CONNECTOR,
    TRINO_CONNECTOR,
} from './connector_info.js';
import {
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionMetrics,
    QueryExecutionState,
} from './query_execution_state.js';
import { ConnectionMetrics, createConnectionMetrics } from './connection_statistics.js';
import { reduceQueryAction } from './query_execution_state.js';
import { DemoConnectionParams as DemoConnectionDetails } from './demo/demo_connection_state.js';
import { reduceTrinoConnectorState, TrinoConnectionDetails, TrinoConnectorAction } from './trino/trino_connection_state.js';

export interface CatalogUpdates {
    /// The running tasks
    tasksRunning: Map<number, CatalogUpdateTaskState>;
    /// The finished tasks
    tasksFinished: Map<number, CatalogUpdateTaskState>;
    /// The most recent catalog update.
    /// We use this to trigger auto-refreshs.
    lastFullRefresh: number | null;
}

export interface ConnectionState {
    /// The connection id
    connectionId: number;
    /// The connection state
    connectionStatus: ConnectionStatus;
    /// The connection health
    connectionHealth: ConnectionHealth;
    /// The connection info
    connectorInfo: ConnectorInfo;
    /// The connection statistics
    metrics: ConnectionMetrics;

    /// The connection details
    details: ConnectionDetailsVariant;

    /// The catalog
    catalog: sqlynx.SQLynxCatalog;
    /// The  catalog updates
    catalogUpdates: CatalogUpdates;

    /// The queries that are currently running
    queriesActive: Map<number, QueryExecutionState>;
    /// The active queries ordered
    queriesActiveOrdered: number[];
    /// The queries that finished (succeeded, failed, cancelled)
    queriesFinished: Map<number, QueryExecutionState>;
    /// The finished queries ordered
    queriesFinishedOrdered: number[];

    /// The snapshot of query ids that are active or finished
    snapshotQueriesActiveFinished: number;
}

export enum ConnectionStatus {
    NOT_STARTED,

    // Generate setup status
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_SUCCEEDED,

    // Channel setup
    CHANNEL_SETUP_STARTED,
    CHANNEL_SETUP_FAILED,
    CHANNEL_SETUP_CANCELLED,
    CHANNEL_READY,

    // Salesforce OAuth
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

export type ConnectionDetailsVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectionDetails>
    | VariantKind<typeof SERVERLESS_CONNECTOR, unknown>
    | VariantKind<typeof DEMO_CONNECTOR, DemoConnectionDetails>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcConnectionDetails>
    | VariantKind<typeof TRINO_CONNECTOR, TrinoConnectionDetails>
    ;

export type ConnectionStateWithoutId = Omit<ConnectionState, "connectionId">;

export const RESET = Symbol('RESET');
export const UPDATE_CATALOG = Symbol('UPDATE_CATALOG');
export const CATALOG_UPDATE_STARTED = Symbol('CATALOG_UPDATE_STARTED');
export const CATALOG_UPDATE_REGISTER_QUERY = Symbol('CATALOG_UPDATE_REGISTER_QUERY');
export const CATALOG_UPDATE_LOAD_DESCRIPTORS = Symbol('CATALOG_UPDATE_LOAD_DESCRIPTORS');
export const CATALOG_UPDATE_SUCCEEDED = Symbol('CATALOG_UPDATE_SUCCEEDED');
export const CATALOG_UPDATE_FAILED = Symbol('CATALOG_UPDATE_FAILED');
export const CATALOG_UPDATE_CANCELLED = Symbol('CATALOG_UPDATE_CANCELLED');

export const EXECUTE_QUERY = Symbol('EXECUTE_QUERY');
export const QUERY_PREPARING = Symbol('QUERY_PREPARING');
export const QUERY_SENDING = Symbol('QUERY_SENDING');
export const QUERY_RUNNING = Symbol('QUERY_RUNNING');
export const QUERY_PROGRESS_UPDATED = Symbol('QUERY_PROGRESS_UPDATED');
export const QUERY_RECEIVED_BATCH = Symbol('QUERY_RECEIVED_BATCH');
export const QUERY_RECEIVED_ALL_BATCHES = Symbol('QUERY_RECEIVED_ALL_BATCHES');
export const QUERY_PROCESSING_RESULTS = Symbol('QUERY_PROCESSING_RESULTS');
export const QUERY_PROCESSED_RESULTS = Symbol('QUERY_PROCESSED_RESULTS');
export const QUERY_SUCCEEDED = Symbol('QUERY_SUCCEEDED');
export const QUERY_FAILED = Symbol('QUERY_FAILED');
export const QUERY_CANCELLED = Symbol('QUERY_CANCELLED');

export type CatalogAction =
    | VariantKind<typeof UPDATE_CATALOG, [number, CatalogUpdateTaskState]>
    | VariantKind<typeof CATALOG_UPDATE_REGISTER_QUERY, [number, number]>
    | VariantKind<typeof CATALOG_UPDATE_LOAD_DESCRIPTORS, [number]>
    | VariantKind<typeof CATALOG_UPDATE_CANCELLED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_FAILED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_SUCCEEDED, [number]>
    ;

export type QueryExecutionAction =
    | VariantKind<typeof EXECUTE_QUERY, [number, QueryExecutionState]>
    | VariantKind<typeof QUERY_PREPARING, [number]>
    | VariantKind<typeof QUERY_SENDING, [number]>
    | VariantKind<typeof QUERY_RUNNING, [number, QueryExecutionResponseStream]>
    | VariantKind<typeof QUERY_PROGRESS_UPDATED, [number, QueryExecutionProgress]>
    | VariantKind<typeof QUERY_RECEIVED_BATCH, [number, arrow.RecordBatch, QueryExecutionMetrics]>
    | VariantKind<typeof QUERY_RECEIVED_ALL_BATCHES, [number, arrow.Table, Map<string, string>, QueryExecutionMetrics]>
    | VariantKind<typeof QUERY_PROCESSING_RESULTS, [number]>
    | VariantKind<typeof QUERY_PROCESSED_RESULTS, [number]>
    | VariantKind<typeof QUERY_SUCCEEDED, [number]>
    | VariantKind<typeof QUERY_FAILED, [number, Error, QueryExecutionMetrics | null]>
    | VariantKind<typeof QUERY_CANCELLED, [number, Error, QueryExecutionMetrics | null]>
    ;

export type ConnectionStateAction =
    | VariantKind<typeof RESET, null>
    | CatalogAction
    | QueryExecutionAction
    | HyperGrpcConnectorAction
    | TrinoConnectorAction
    | SalesforceConnectionStateAction
    ;

export function reduceConnectionState(state: ConnectionState, action: ConnectionStateAction): ConnectionState {
    switch (action.type) {
        case UPDATE_CATALOG:
        case CATALOG_UPDATE_REGISTER_QUERY:
        case CATALOG_UPDATE_LOAD_DESCRIPTORS:
        case CATALOG_UPDATE_CANCELLED:
        case CATALOG_UPDATE_SUCCEEDED:
        case CATALOG_UPDATE_FAILED:
            return reduceCatalogAction(state, action);

        case EXECUTE_QUERY:
        case QUERY_PREPARING:
        case QUERY_RUNNING:
        case QUERY_SENDING:
        case QUERY_PROGRESS_UPDATED:
        case QUERY_RECEIVED_BATCH:
        case QUERY_RECEIVED_ALL_BATCHES:
        case QUERY_PROCESSING_RESULTS:
        case QUERY_PROCESSED_RESULTS:
        case QUERY_SUCCEEDED:
        case QUERY_CANCELLED:
        case QUERY_FAILED:
            return reduceQueryAction(state, action);

        // RESET is a bit special since we want to clean up our details as well
        case RESET: {
            // Reset the SQLynx catalog
            state.catalog.clear();

            // XXX Cancel currently running queries

            // Cleanup query executions and catalog
            const cleaned: ConnectionState = {
                ...state,
                connectionStatus: ConnectionStatus.NOT_STARTED,
                connectionHealth: ConnectionHealth.NOT_STARTED,
                metrics: createConnectionMetrics(),
                catalogUpdates: {
                    tasksRunning: new Map(),
                    tasksFinished: new Map(),
                    lastFullRefresh: null,
                },
                queriesActive: new Map(),
                queriesFinished: new Map(),
            };
            // Cleanup the details
            let details: ConnectionState | null = null;
            switch (state.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    details = reduceSalesforceConnectionState(cleaned, action as SalesforceConnectionStateAction);
                    break;
                case HYPER_GRPC_CONNECTOR:
                    details = reduceHyperGrpcConnectorState(cleaned, action as HyperGrpcConnectorAction);
                    break;
                case HYPER_GRPC_CONNECTOR:
                    details = reduceTrinoConnectorState(cleaned, action as TrinoConnectorAction);
                    break;
                case SERVERLESS_CONNECTOR:
                case DEMO_CONNECTOR:
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
                case TRINO_CONNECTOR:
                    next = reduceTrinoConnectorState(state, action as TrinoConnectorAction);
                    break;
                case SERVERLESS_CONNECTOR:
                case DEMO_CONNECTOR:
                    break;
            }
            if (next == null) {
                throw new Error(`failed to apply state action: ${String(action.type)}`);
            }
            return next;
        }
    }
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
        catalogUpdates: {
            tasksRunning: new Map(),
            tasksFinished: new Map(),
            lastFullRefresh: null,
        },
        snapshotQueriesActiveFinished: 1,
        queriesActive: new Map(),
        queriesActiveOrdered: [],
        queriesFinished: new Map(),
        queriesFinishedOrdered: [],
    };
}

export function createServerlessConnectionState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    return createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.SERVERLESS], {
        type: SERVERLESS_CONNECTOR,
        value: {}
    });
}
