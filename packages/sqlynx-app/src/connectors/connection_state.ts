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
import { CatalogUpdateTaskState, reduceCatalogAction } from './catalog_update_state.js';
import { VariantKind } from '../utils/variant.js';
import {
    CONNECTOR_INFOS,
    ConnectorInfo,
    ConnectorType,
    HYPER_GRPC_CONNECTOR,
    SALESFORCE_DATA_CLOUD_CONNECTOR,
    SERVERLESS_CONNECTOR,
} from './connector_info.js';
import {
    QueryExecutionProgress,
    QueryExecutionResponseStream,
    QueryExecutionResponseStreamMetrics,
    QueryExecutionState,
} from './query_execution_state.js';
import { ConnectionMetrics, createConnectionMetrics } from './connection_statistics.js';
import { reduceQueryAction } from './query_execution_state.js';

export interface ConnectionState {
    /// The connection id
    connectionId: number;
    /// The connection state
    connectionStatus: ConnectionStatus;
    /// The connection health
    connectionHealth: ConnectionHealth;
    /// The connection info
    connectionInfo: ConnectorInfo;
    /// The connection statistics
    metrics: ConnectionMetrics;

    /// The connection details
    details: ConnectionDetailsVariant;

    /// The catalog
    catalog: sqlynx.SQLynxCatalog;
    /// The catalog updates that are currently running
    catalogUpdatesRunning: Map<number, CatalogUpdateTaskState>;
    /// The catalog updates that are currently running
    catalogUpdatesFinished: Map<number, CatalogUpdateTaskState>;

    /// The queries that are currently running
    queriesRunning: Map<number, QueryExecutionState>;
    /// The queries that finished (succeeded, failed, cancelled)
    queriesFinished: Map<number, QueryExecutionState>;
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

export type ConnectionDetailsVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, SalesforceConnectionDetails>
    | VariantKind<typeof SERVERLESS_CONNECTOR, unknown>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, HyperGrpcConnectionDetails>
    ;

export type ConnectionStateWithoutId = Omit<ConnectionState, "connectionId">;

export const RESET = Symbol('RESET');
export const UPDATE_CATALOG = Symbol('UPDATE_CATALOG');
export const CATALOG_UPDATE_STARTED = Symbol('CATALOG_UPDATE_STARTED');
export const CATALOG_UPDATE_SUCCEEDED = Symbol('CATALOG_UPDATE_SUCCEEDED');
export const CATALOG_UPDATE_FAILED = Symbol('CATALOG_UPDATE_FAILED');
export const CATALOG_UPDATE_CANCELLED = Symbol('CATALOG_UPDATE_CANCELLED');

export const EXECUTE_QUERY = Symbol('EXECUTE_QUERY');
export const QUERY_EXECUTION_STARTED = Symbol('QUERY_EXECUTION_STARTED');
export const QUERY_EXECUTION_PROGRESS_UPDATED = Symbol('QUERY_EXECUTION_PROGRESS_UPDATED');
export const QUERY_EXECUTION_RECEIVED_SCHEMA = Symbol('QUERY_EXECUTION_RECEIVED_SCHEMA');
export const QUERY_EXECUTION_RECEIVED_BATCH = Symbol('QUERY_EXECUTION_RECEIVED_BATCH');
export const QUERY_EXECUTION_SUCCEEDED = Symbol('QUERY_EXECUTION_SUCCEEDED');
export const QUERY_EXECUTION_FAILED = Symbol('QUERY_EXECUTION_FAILED');
export const QUERY_EXECUTION_CANCELLED = Symbol('QUERY_EXECUTION_CANCELLED');

export type CatalogAction =
    | VariantKind<typeof UPDATE_CATALOG, [number, CatalogUpdateTaskState]>
    | VariantKind<typeof CATALOG_UPDATE_CANCELLED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_FAILED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_SUCCEEDED, [number]>
    ;

export type QueryExecutionAction =
    | VariantKind<typeof EXECUTE_QUERY, [number, QueryExecutionState]>
    | VariantKind<typeof QUERY_EXECUTION_STARTED, [number, QueryExecutionResponseStream]>
    | VariantKind<typeof QUERY_EXECUTION_PROGRESS_UPDATED, [number, QueryExecutionProgress]>
    | VariantKind<typeof QUERY_EXECUTION_RECEIVED_SCHEMA, [number, arrow.Schema]>
    | VariantKind<typeof QUERY_EXECUTION_RECEIVED_BATCH, [number, arrow.RecordBatch, QueryExecutionResponseStreamMetrics]>
    | VariantKind<typeof QUERY_EXECUTION_SUCCEEDED, [number, arrow.RecordBatch | null, QueryExecutionResponseStreamMetrics]>
    | VariantKind<typeof QUERY_EXECUTION_FAILED, [number, Error, QueryExecutionResponseStreamMetrics | null]>
    | VariantKind<typeof QUERY_EXECUTION_CANCELLED, [number, Error, QueryExecutionResponseStreamMetrics | null]>
    ;

export type ConnectionStateAction =
    | VariantKind<typeof RESET, null>
    | CatalogAction
    | QueryExecutionAction
    | HyperGrpcConnectorAction
    | SalesforceConnectionStateAction
    ;

export function reduceConnectionState(state: ConnectionState, action: ConnectionStateAction): ConnectionState {
    switch (action.type) {
        case UPDATE_CATALOG:
        case CATALOG_UPDATE_CANCELLED:
        case CATALOG_UPDATE_SUCCEEDED:
        case CATALOG_UPDATE_FAILED:
            return reduceCatalogAction(state, action);

        case EXECUTE_QUERY:
        case QUERY_EXECUTION_STARTED:
        case QUERY_EXECUTION_PROGRESS_UPDATED:
        case QUERY_EXECUTION_RECEIVED_SCHEMA:
        case QUERY_EXECUTION_RECEIVED_BATCH:
        case QUERY_EXECUTION_SUCCEEDED:
        case QUERY_EXECUTION_CANCELLED:
        case QUERY_EXECUTION_FAILED:
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
                catalogUpdatesRunning: new Map(),
                catalogUpdatesFinished: new Map(),
                queriesRunning: new Map(),
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

export function createConnectionState(lnx: sqlynx.SQLynx, info: ConnectorInfo, details: ConnectionDetailsVariant): ConnectionStateWithoutId {
    const catalog = lnx.createCatalog();
    return {
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectionInfo: info,
        metrics: createConnectionMetrics(),
        details,
        catalog,
        catalogUpdatesRunning: new Map(),
        catalogUpdatesFinished: new Map(),
        queriesRunning: new Map(),
        queriesFinished: new Map(),
    };
}

export function createServerlessConnectionState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    return createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.SERVERLESS], {
        type: SERVERLESS_CONNECTOR,
        value: {}
    });
}