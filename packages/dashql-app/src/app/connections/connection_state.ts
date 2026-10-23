import * as core from '@ankoh/dashql-core';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { HyperConnectorAction, reduceHyperConnectorState } from './hyper/hyper_connection_state.js';
import { SalesforceConnectionStateAction, reduceSalesforceConnectionState } from './salesforce/salesforce_connection_state.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, CatalogUpdateTaskState, reduceCatalogAction } from './catalog_update_state.js';
import { generateCatalogScriptHeader, CatalogSource } from './catalog_sql_generator.js';
import { generateFunctionScriptHeader } from './catalog_function_sql_generator.js';
import { VariantKind } from '../../utils/variant.js';
import {
    CONNECTOR_INFOS,
    ConnectorInfo,
    getConnectorInfoForParams,
    ConnectorType,
    HYPER_CONNECTOR,
    SALESFORCE_DATA_CLOUD_CONNECTOR,
    TRINO_CONNECTOR,
} from './connector_info.js';
import {
    createQueryExecutionMetrics,
    EXECUTE_QUERY,
    QUERY_CANCELLED,
    QUERY_FAILED,
    QUERY_PROGRESS_UPDATED,
    QUERY_STATEMENT_STARTED,
    QUERY_STATEMENT_SUCCEEDED,
    QUERY_RECEIVED_BATCH,
    QUERY_RUNNING,
    QUERY_RECEIVED_ALL_BATCHES,
    QueryExecutionAction,
    QUERY_SUCCEEDED,
    QUERY_PROCESSED_RESULTS,
    QUERY_PREPARING,
    QUERY_SENDING,
    QUERY_PROCESSING_RESULTS,
    QUERY_CACHE_RECORDED,
    QUERY_CACHE_DELETED,
    QueryExecutionState,
} from '../../query/query_execution_state.js';
import { reduceQueryAction } from '../../query/query_execution_state.js';
import { reduceTrinoConnectorState, TrinoConnectorAction } from './trino/trino_connection_state.js';
import { ConnectionStateDetailsVariant, createConnectionStateDetails } from './connection_state_details.js';
import { Logger, stringifyError } from '../../platform/logger/logger.js';
import { invalidateCatalogBatch } from './catalog_batch.js';
import { connectionParamsEqual, connectionParamsWithoutDraftRows, getConnectionParamsFromStateDetails, type ConnectionParams } from './connection_params.js';
import { HYPER_CHANNEL_SETUP_STARTED } from './hyper/hyper_connection_state.js';
import { OAUTH_STARTED, TRINO_CHANNEL_SETUP_STARTED } from './trino/trino_connection_state.js';
import { SETUP_STARTED } from './salesforce/salesforce_connection_state.js';
import { cancelConnectionSetup } from './connection_setup_cancellation.js';
import { dateToTimestamp } from './proto_helper.js';
import type { DetailedError } from '../../utils/error.js';
import { catalogNameDefaults } from './catalog_name_defaults.js';

const LOG_CTX = 'connection_state';

export interface CatalogUpdates {
    /// The running tasks
    tasksRunning: Map<number, CatalogUpdateTaskState>;
    /// The finished tasks
    tasksFinished: Map<number, CatalogUpdateTaskState>;
    /// Restored at a certain time
    restoredAt: Date | null;
    /// The id of the running or most recently completed full refresh.
    /// Set at UPDATE_CATALOG start; used to decide whether to kick off
    /// an auto-refresh and to surface the currently-displayed refresh task.
    currentFullRefresh: number | null;
    /// The id of the most recently *completed*, non-superseded full refresh
    /// (succeeded, failed, or cancelled). Only advances on completion, so components
    /// can depend on it to react when the catalog script has been updated.
    lastFullRefresh: number | null;
}

export interface ConnectionState {
    /// Runtime identity of the connection.
    connectionId: string;

    /// The connection state contains many references into the Wasm heap.
    /// It therefore makes sense that connection state users resolve the "right" module through here.
    instance: core.DashQL;
    /// Whether the database belongs to a committed session or has connected at least once.
    /// Draft manifest writes are independent of activation; catalog writes require activation.
    active: boolean;

    /// The connection state
    connectionStatus: ConnectionStatus;
    /// The connection health
    connectionHealth: ConnectionHealth;
    /// The connection info
    connectorInfo: ConnectorInfo;
    /// The user-assigned display name, absent when the connection is unnamed
    name?: string;

    /// The connection details
    details: ConnectionStateDetailsVariant;
    /// Last successful parameters (initial defaults until the first successful setup).
    params: ConnectionParams;
    /// Local editable settings, independent of the runtime channel and OAuth state.
    paramsDraft?: ConnectionParams;
    /// Immutable input of the current setup attempt; never persisted.
    setupAttemptParams?: ConnectionParams;
    /// Draft at attempt start, including raw form rows, for exact successful-discard comparison.
    setupAttemptDraft?: ConnectionParams;
    /// The connection statistics
    metrics: connection.ConnectionMetrics;

    /// The catalog
    catalog: core.DashQLCatalog;
    /// The  catalog updates
    catalogUpdates: CatalogUpdates;
    /// The catalog relation script (consolidated SQL for all relations)
    catalogRelationScript: core.DashQLScript;
    /// The catalog function script (consolidated SQL for all function declarations)
    catalogFunctionScript: core.DashQLScript;
    /// The catalog changes of executed statements since the last catalog refresh, as SQL.
    /// They are applied to the relation descriptor on top of the relation script.
    catalogChangesSql: string;

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

    // Generate OAuth
    AUTH_STARTED,
    AUTH_CANCELLED,
    AUTH_FAILED,
    PKCE_GENERATION_STARTED,
    PKCE_GENERATED,
    WAITING_FOR_OAUTH_CODE_VIA_WINDOW,
    WAITING_FOR_OAUTH_CODE_VIA_LINK,
    OAUTH_CODE_RECEIVED,
    ACCESS_TOKEN_REQUESTED,
    ACCESS_TOKEN_RECEIVED,

    // Salesforce OAuth
    DATA_CLOUD_TOKEN_REQUESTED,
    DATA_CLOUD_TOKEN_RECEIVED,
    CORE_ACCESS_TOKEN_REQUESTED,
    CORE_ACCESS_TOKEN_RECEIVED,
}

export enum ConnectionHealth {
    NOT_STARTED = 0,
    CONNECTING = 1,
    CANCELLED = 2,
    ONLINE = 3,
    FAILED = 4,
}

export function printConnectionHealth(health: ConnectionHealth) {
    switch (health) {
        case ConnectionHealth.NOT_STARTED:
            return "Not Started";
        case ConnectionHealth.CONNECTING:
            return "Connecting";
        case ConnectionHealth.CANCELLED:
            return "Cancelled";
        case ConnectionHealth.ONLINE:
            return "Online";
        case ConnectionHealth.FAILED:
            return "Failed";
    }
}

export type ConnectionStateWithoutId = Omit<ConnectionState, "connectionId">;

export const DELETE_CONNECTION = Symbol('DELETE_CONNECTION');
export const RESET_CONNECTION = Symbol('RESET_CONNECTION');
export const SWITCH_CONNECTOR_TYPE = Symbol('SWITCH_CONNECTOR_TYPE');
export const SET_CATALOG_SCRIPT = Symbol('SET_CATALOG_SCRIPT');
export const APPLY_CATALOG_CHANGES = Symbol('APPLY_CATALOG_CHANGES');
export const UPDATE_CATALOG = Symbol('UPDATE_CATALOG');
export const CATALOG_UPDATE_STARTED = Symbol('CATALOG_UPDATE_STARTED');
export const CATALOG_UPDATE_REGISTER_QUERY = Symbol('CATALOG_UPDATE_REGISTER_QUERY');
export const CATALOG_UPDATE_SCHEMA_SCRIPT = Symbol('CATALOG_UPDATE_SCHEMA_SCRIPT');
export const CATALOG_UPDATE_SUCCEEDED = Symbol('CATALOG_UPDATE_SUCCEEDED');
export const CATALOG_UPDATE_PARTIALLY_SUCCEEDED = Symbol('CATALOG_UPDATE_PARTIALLY_SUCCEEDED');
export const CATALOG_UPDATE_FAILED = Symbol('CATALOG_UPDATE_FAILED');
export const CATALOG_UPDATE_CANCELLED = Symbol('CATALOG_UPDATE_CANCELLED');

export const HEALTH_CHECK_STARTED = Symbol('HEALTH_CHECK_STARTED');
export const HEALTH_CHECK_CANCELLED = Symbol('HEALTH_CHECK_CANCELLED');
export const HEALTH_CHECK_SUCCEEDED = Symbol('HEALTH_CHECK_SUCCEEDED');
export const HEALTH_CHECK_FAILED = Symbol('HEALTH_CHECK_FAILED');
export const SET_CONNECTION_DRAFT = Symbol('SET_CONNECTION_DRAFT');
export const DISCARD_CONNECTION_DRAFT = Symbol('DISCARD_CONNECTION_DRAFT');
export const COMMIT_CONNECTION_PARAMS = Symbol('COMMIT_CONNECTION_PARAMS');
export const SET_CONNECTION_NAME = Symbol('SET_CONNECTION_NAME');

export type CatalogAction =
    | VariantKind<typeof SET_CATALOG_SCRIPT, core.DashQLScript>
    | VariantKind<typeof APPLY_CATALOG_CHANGES, core.buffers.catalog.CatalogChangeT[]>
    | VariantKind<typeof UPDATE_CATALOG, [number, CatalogUpdateTaskState]>
    | VariantKind<typeof CATALOG_UPDATE_REGISTER_QUERY, [number, number]>
    | VariantKind<typeof CATALOG_UPDATE_SCHEMA_SCRIPT, [number]>
    | VariantKind<typeof CATALOG_UPDATE_CANCELLED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_FAILED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_SUCCEEDED, [number]>
    | VariantKind<typeof CATALOG_UPDATE_PARTIALLY_SUCCEEDED, [number, Error]>
    ;

/// The health check of a connection, every connector runs it the same way
export type HealthCheckAction =
    | VariantKind<typeof HEALTH_CHECK_STARTED, null>
    | VariantKind<typeof HEALTH_CHECK_CANCELLED, null>
    | VariantKind<typeof HEALTH_CHECK_FAILED, DetailedError>
    | VariantKind<typeof HEALTH_CHECK_SUCCEEDED, null>
    ;

export type ConnectionAction =
    | VariantKind<typeof SET_CONNECTION_DRAFT, ConnectionParams>
    | VariantKind<typeof DISCARD_CONNECTION_DRAFT, null>
    | VariantKind<typeof COMMIT_CONNECTION_PARAMS, ConnectionParams>
    | VariantKind<typeof DELETE_CONNECTION, null>
    | VariantKind<typeof RESET_CONNECTION, null>
    | VariantKind<typeof SWITCH_CONNECTOR_TYPE, ConnectorType>
    | VariantKind<typeof SET_CONNECTION_NAME, string | null>
    | HealthCheckAction
    | CatalogAction
    | QueryExecutionAction
    | HyperConnectorAction
    | TrinoConnectorAction
    | SalesforceConnectionStateAction
    ;

export function reduceConnectionState(state: ConnectionState, action: ConnectionAction, logger: Logger): ConnectionState {
    switch (action.type) {
        case SET_CONNECTION_DRAFT: {
            if (getConnectorInfoForParams(action.value)?.connectorType !== state.connectorInfo.connectorType) return state;
            const paramsDraft = structuredClone(action.value);
            if (connectionParamsEqual(state.paramsDraft, paramsDraft)) return state;
            return { ...state, paramsDraft };
        }
        // COMMIT_CONNECTION_PARAMS makes saved params the params of the connection.
        // The draft is cleared unless it changed while saving.
        case COMMIT_CONNECTION_PARAMS: {
            const params = connectionParamsWithoutDraftRows(structuredClone(action.value));
            const draftSaved = state.paramsDraft == null
                || connectionParamsEqual(connectionParamsWithoutDraftRows(state.paramsDraft), params);
            if (connectionParamsEqual(state.params, params) && (state.paramsDraft == null || !draftSaved)) return state;
            return { ...state, params, paramsDraft: draftSaved ? undefined : state.paramsDraft };
        }
        case DISCARD_CONNECTION_DRAFT: {
            if (state.connectionHealth === ConnectionHealth.CONNECTING) return state;
            const details = {
                ...state.details,
                value: {
                    ...state.details.value,
                    proto: {
                        ...state.details.value.proto,
                        setupError: undefined,
                        channelError: undefined,
                        schemaResolutionError: undefined,
                        healthCheckError: undefined,
                    },
                },
            } as unknown as ConnectionStateDetailsVariant;
            return { ...state, paramsDraft: undefined, details };
        }
        case SET_CATALOG_SCRIPT:
            return {
                ...state,
                catalogRelationScript: action.value,
            };

        case APPLY_CATALOG_CHANGES:
            return applyCatalogChanges(state, action.value, logger);

        case UPDATE_CATALOG:
        case CATALOG_UPDATE_REGISTER_QUERY:
        case CATALOG_UPDATE_SCHEMA_SCRIPT:
        case CATALOG_UPDATE_CANCELLED:
        case CATALOG_UPDATE_SUCCEEDED:
        case CATALOG_UPDATE_PARTIALLY_SUCCEEDED:
        case CATALOG_UPDATE_FAILED:
            return reduceCatalogAction(state, action);

        case EXECUTE_QUERY:
        case QUERY_PREPARING:
        case QUERY_RUNNING:
        case QUERY_SENDING:
        case QUERY_PROGRESS_UPDATED:
        case QUERY_STATEMENT_STARTED:
        case QUERY_STATEMENT_SUCCEEDED:
        case QUERY_RECEIVED_BATCH:
        case QUERY_RECEIVED_ALL_BATCHES:
        case QUERY_PROCESSING_RESULTS:
        case QUERY_PROCESSED_RESULTS:
        case QUERY_SUCCEEDED:
        case QUERY_CANCELLED:
        case QUERY_FAILED:
        case QUERY_CACHE_RECORDED:
        case QUERY_CACHE_DELETED:
            return reduceQueryAction(state, action);

        // RESET_CONNECTION stops the connection and clears its catalog
        case RESET_CONNECTION: {
            // Pending catalog publishers are aborted before the catalog is cleared
            const newState = stopConnection(state, action, 'reset');
            state.catalog.clear();
            return newState;
        }

        // SWITCH_CONNECTOR_TYPE changes the connection's type in-place.
        // Only allowed when the connection hasn't been configured yet.
        case SWITCH_CONNECTOR_TYPE: {
            if (state.connectionStatus !== ConnectionStatus.NOT_STARTED || state.active || state.paramsDraft != null) {
                return state;
            }
            const newType = action.value;
            if (state.connectorInfo.connectorType === newType) {
                return state;
            }
            const newInfo = CONNECTOR_INFOS[newType as number];
            const newDetails = createConnectionStateDetails(newType);
            return {
                ...state,
                connectorInfo: newInfo,
                details: newDetails,
                params: getConnectionParamsFromStateDetails(newDetails)!,
                paramsDraft: undefined,
                setupAttemptParams: undefined,
                setupAttemptDraft: undefined,
            };
        }

        // SET_CONNECTION_NAME names the connection, a blank name removes the name
        case SET_CONNECTION_NAME: {
            const name = normalizeConnectionName(action.value);
            if (name === state.name) return state;
            return { ...state, name };
        }

        /// DELETE_CONNECTION stops the connection and destroys its catalog.
        /// The registry refuses to delete connections that sessions reference.
        case DELETE_CONNECTION: {
            const newState = stopConnection(state, action, 'deleted');

            // Text-only source scripts do not own their published descriptors.
            try {
                state.catalog.dropDescriptor(state.catalogRelationScript.catalog_entry_id);
            } catch (e) {
                // Descriptor may have already been dropped - ignore error
            }
            state.catalogRelationScript.destroy();
            try {
                state.catalog.dropDescriptor(state.catalogFunctionScript.catalog_entry_id);
            } catch (e) {
                // Descriptor may have already been dropped - ignore error
            }
            state.catalogFunctionScript.destroy();

            // Delete the conneciton catalog
            state.catalog.destroy();

            return newState;
        }

        default: {
            // Capture setup input before connector reducers replace runtime setupParams.
            let setupAttemptParams = state.setupAttemptParams;
            let setupAttemptDraft = state.setupAttemptDraft;
            switch (action.type) {
                case HYPER_CHANNEL_SETUP_STARTED:
                    setupAttemptParams = structuredClone({ hyper: action.value });
                    setupAttemptDraft = state.paramsDraft;
                    break;
                case OAUTH_STARTED:
                case TRINO_CHANNEL_SETUP_STARTED:
                    setupAttemptParams = structuredClone({ trino: action.value });
                    setupAttemptDraft = state.setupAttemptParams == null ? state.paramsDraft : state.setupAttemptDraft;
                    break;
                case SETUP_STARTED:
                    setupAttemptParams = structuredClone({ salesforce: action.value });
                    setupAttemptDraft = state.paramsDraft;
                    break;
            }
            let newState = reduceHealthCheck(state, action) ?? reduceConnectorDetails(state, action);
            if (newState == null) {
                throw new Error(`failed to apply state action: ${String(action.type)}`);
            }
            newState = { ...newState, setupAttemptParams, setupAttemptDraft };
            if (newState.connectionHealth === ConnectionHealth.ONLINE
                && state.connectionHealth !== ConnectionHealth.ONLINE && setupAttemptParams != null) {
                newState = {
                    ...newState,
                    params: connectionParamsWithoutDraftRows(setupAttemptParams),
                    paramsDraft: connectionParamsEqual(state.paramsDraft, setupAttemptDraft)
                        && (setupAttemptDraft == null || connectionParamsEqual(connectionParamsWithoutDraftRows(setupAttemptDraft), connectionParamsWithoutDraftRows(setupAttemptParams)))
                        ? undefined : state.paramsDraft,
                    setupAttemptParams: undefined,
                    setupAttemptDraft: undefined,
                };
                if ('salesforce' in setupAttemptParams && newState.details.type === SALESFORCE_DATA_CLOUD_CONNECTOR) {
                    newState.params = { salesforce: {
                        ...setupAttemptParams.salesforce,
                        login: newState.details.value.proto.setupParams?.login ?? setupAttemptParams.salesforce.login,
                    } };
                }
            } else if (newState.connectionHealth === ConnectionHealth.FAILED || newState.connectionHealth === ConnectionHealth.CANCELLED) {
                newState.setupAttemptParams = undefined;
                newState.setupAttemptDraft = undefined;
            }

            // Embedded connectors become online as soon as their local channel is ready, without a
            // health-check action. Activate every database on its first transition to online.
            if (newState.connectionHealth === ConnectionHealth.ONLINE && !newState.active) {
                newState = { ...newState, active: true };
            }

            return newState;
        }
    }
}

/// Apply a health check action, null for other actions
function reduceHealthCheck(state: ConnectionState, action: ConnectionAction): ConnectionState | null {
    const now = dateToTimestamp(new Date());
    switch (action.type) {
        case HEALTH_CHECK_STARTED:
            return withConnectorProto({ ...state, connectionStatus: ConnectionStatus.HEALTH_CHECK_STARTED, connectionHealth: ConnectionHealth.CONNECTING },
                proto => ({ ...proto, setupTimings: { ...proto.setupTimings, healthCheckStartedAt: now } }));
        case HEALTH_CHECK_FAILED:
            return withConnectorProto({ ...state, connectionStatus: ConnectionStatus.HEALTH_CHECK_FAILED, connectionHealth: ConnectionHealth.FAILED },
                proto => ({ ...proto, setupTimings: { ...proto.setupTimings, healthCheckFailedAt: now }, healthCheckError: action.value }));
        case HEALTH_CHECK_CANCELLED:
            return withConnectorProto({ ...state, connectionStatus: ConnectionStatus.HEALTH_CHECK_CANCELLED, connectionHealth: ConnectionHealth.CANCELLED },
                proto => ({ ...proto, setupTimings: { ...proto.setupTimings, healthCheckCancelledAt: now } }));
        case HEALTH_CHECK_SUCCEEDED:
            return withConnectorProto({ ...state, connectionStatus: ConnectionStatus.HEALTH_CHECK_SUCCEEDED, connectionHealth: ConnectionHealth.ONLINE },
                proto => ({ ...proto, setupTimings: { ...proto.setupTimings, healthCheckSucceededAt: now } }));
        default:
            return null;
    }
}

/// The setup timings and errors that the details of every connector keep
type ConnectorProto = Pick<ConnectionStateDetailsVariant['value']['proto'], 'setupTimings' | 'healthCheckError'>;

/// Update the setup timings and errors of the connector details
function withConnectorProto(state: ConnectionState, patch: (proto: ConnectorProto) => ConnectorProto): ConnectionState {
    const details = state.details.value;
    return {
        ...state,
        details: { ...state.details, value: { ...details, proto: { ...details.proto, ...patch(details.proto) } } } as ConnectionStateDetailsVariant,
    };
}

/// Let the reducer of the connector apply an action to the connection details
function reduceConnectorDetails(state: ConnectionState, action: ConnectionAction): ConnectionState | null {
    switch (state.details.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return reduceSalesforceConnectionState(state, action as SalesforceConnectionStateAction);
        case HYPER_CONNECTOR:
            return reduceHyperConnectorState(state, action as HyperConnectorAction);
        case TRINO_CONNECTOR:
            return reduceTrinoConnectorState(state, action as TrinoConnectorAction);
    }
}

/// Stop a connection that is reset or deleted.
/// Cancels the setup and the running catalog updates and drops the query executions.
function stopConnection(state: ConnectionState, action: ConnectionAction, reason: 'reset' | 'deleted'): ConnectionState {
    cancelConnectionSetup(state.connectionId);
    invalidateCatalogBatch(state.catalog);
    for (const task of state.catalogUpdates.tasksRunning.values()) {
        task.cancellation.abort(new DOMException(`Connection was ${reason}`, 'AbortError'));
    }
    // XXX Cancel currently running queries
    const cleaned: ConnectionState = {
        ...state,
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        setupAttemptParams: undefined,
        setupAttemptDraft: undefined,
        metrics: createConnectionMetrics(),
        catalogUpdates: {
            tasksRunning: new Map(),
            tasksFinished: new Map(),
            currentFullRefresh: null,
            lastFullRefresh: null,
            restoredAt: null,
        },
        queriesActive: new Map(),
        queriesFinished: new Map(),
    };
    // Cleaning up the details is best-effort, the connector may ignore the action
    return reduceConnectorDetails(cleaned, action) ?? cleaned;
}

/// Apply the catalog changes of executed statements to the relation descriptor and record them as SQL.
/// The changes are qualified with the default database and schema of the connection.
///
/// Known limitation: the changes don't distinguish temporary relations. A `CREATE TEMP TABLE` is
/// recorded and persisted like any other relation, so it outlives the database session it belongs to
/// and is restored with the catalog after a reconnect.
function applyCatalogChanges(state: ConnectionState, changes: core.buffers.catalog.CatalogChangeT[], logger: Logger): ConnectionState {
    if (changes.length === 0) return state;
    try {
        const qualified = state.instance.qualifyCatalogChanges(changes, catalogNameDefaults(state.details));
        state.catalog.applyCatalogChanges(state.catalogRelationScript.catalog_entry_id, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, qualified);
        const catalogChangesSql = state.instance.appendCatalogChangesSql(state.catalogChangesSql, qualified);
        logger.info('Applied catalog changes of executed statements', {
            connectionId: state.connectionId,
            changes: qualified.length.toString(),
        }, LOG_CTX);
        return { ...state, catalogChangesSql };
    } catch (e: unknown) {
        logger.error('Failed to apply catalog changes of executed statements', {
            connectionId: state.connectionId,
            error: stringifyError(e),
        }, LOG_CTX);
        return state;
    }
}

/// The display name of a connection without surrounding whitespace, undefined if it is blank
export function normalizeConnectionName(name: string | null | undefined): string | undefined {
    const trimmed = name?.trim() ?? '';
    return trimmed.length === 0 ? undefined : trimmed;
}

export function createConnectionMetrics(): connection.ConnectionMetrics {
    return createQueryExecutionMetrics();
}

/// The optional properties of a new connection state
export interface ConnectionStateOptions {
    /// Does the connection belong to a committed session or was it connected once?
    active?: boolean;
    /// The params, derived from the details by default
    params?: ConnectionParams;
    /// The draft of the params
    paramsDraft?: ConnectionParams;
    /// The name
    name?: string;
}

/// Create the state of a connection with an empty catalog
export function createConnectionState(dql: core.DashQL, info: ConnectorInfo, details: ConnectionStateDetailsVariant, options: ConnectionStateOptions = {}): ConnectionStateWithoutId {
    let catalog: core.DashQLCatalog | null = null;
    let catalogRelationScript: core.DashQLScript | null = null;
    let catalogFunctionScript: core.DashQLScript | null = null;
    try {
        catalog = dql.createCatalog();
        catalogRelationScript = dql.createScript(catalog);
        catalogRelationScript.replaceText(generateCatalogScriptHeader(CatalogSource.Unknown));
        catalogFunctionScript = dql.createScript(catalog);
        catalogFunctionScript.replaceText(generateFunctionScriptHeader(CatalogSource.Unknown));
    } catch (error) {
        catalogFunctionScript?.destroy();
        catalogRelationScript?.destroy();
        catalog?.destroy();
        throw error;
    }
    return {
        instance: dql,
        active: options.active ?? false,
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectorInfo: info,
        metrics: createConnectionMetrics(),
        details,
        params: options.params == null ? getConnectionParamsFromStateDetails(details)! : structuredClone(options.params),
        paramsDraft: options.paramsDraft == null ? undefined : structuredClone(options.paramsDraft),
        name: normalizeConnectionName(options.name),
        catalog,
        catalogUpdates: {
            tasksRunning: new Map(),
            tasksFinished: new Map(),
            currentFullRefresh: null,
            lastFullRefresh: null,
            restoredAt: null,
        },
        catalogRelationScript,
        catalogFunctionScript,
        catalogChangesSql: '',
        snapshotQueriesActiveFinished: 1,
        queriesActive: new Map(),
        queriesActiveOrdered: [],
        queriesFinished: new Map(),
        queriesFinishedOrdered: [],
    };
}
