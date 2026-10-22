import * as core from '@ankoh/dashql-core';
import * as dashql from '@ankoh/dashql-core';
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
} from './query_execution_state.js';
import { Hasher } from '../../utils/hash.js';
import { reduceQueryAction } from './query_execution_state.js';
import { reduceTrinoConnectorState, TrinoConnectorAction } from './trino/trino_connection_state.js';
import { computeConnectionSignatureFromDetails, computeNewConnectionSignatureFromDetails, ConnectionStateDetailsVariant, createConnectionStateDetails } from './connection_state_details.js';
import { ConnectionSignatureMap, ConnectionSignatureState, newConnectionSignature } from './connection_signature.js';
import { StorageWriter } from '../storage/storage_writer.js';
import { Logger, stringifyError } from '../../platform/logger/logger.js';
import { invalidateCatalogBatch, publishCatalogBatchSync, type CatalogBatchEntry } from './catalog_batch.js';
import { connectionParamsEqual, connectionParamsWithoutDraftRows, getConnectionInfoFromParams, getConnectionParamsFromStateDetails, type ConnectionParams } from './connection_params.js';
import { HYPER_CHANNEL_SETUP_STARTED } from './hyper/hyper_connection_state.js';
import { OAUTH_STARTED, TRINO_CHANNEL_SETUP_STARTED } from './trino/trino_connection_state.js';
import { SETUP_STARTED } from './salesforce/salesforce_connection_state.js';
import { cancelConnectionSetup } from './connection_setup_cancellation.js';
import { catalogNameDefaults } from './catalog_name_defaults.js';

const LOG_CTX = 'attached_database_state';

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

export interface AttachedDatabaseState {
    /// Runtime identity of the attached database.
    databaseId: string;

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
    /// The connection signature
    connectionSignature: ConnectionSignatureState;

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
    catalog: dashql.DashQLCatalog;
    /// The  catalog updates
    catalogUpdates: CatalogUpdates;
    /// The catalog relation script (consolidated SQL for all relations)
    catalogRelationScript: dashql.DashQLScript;
    /// The catalog function script (consolidated SQL for all function declarations)
    catalogFunctionScript: dashql.DashQLScript;
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

export function canDeleteConnectionWithStatus(status: ConnectionStatus) {
    switch (status) {
        case ConnectionStatus.AUTH_CANCELLED:
        case ConnectionStatus.AUTH_FAILED:
        case ConnectionStatus.CHANNEL_SETUP_CANCELLED:
        case ConnectionStatus.CHANNEL_SETUP_FAILED:
        case ConnectionStatus.CHANNEL_SETUP_STARTED:
        case ConnectionStatus.CORE_ACCESS_TOKEN_RECEIVED:
        case ConnectionStatus.DATA_CLOUD_TOKEN_RECEIVED:
        case ConnectionStatus.HEALTH_CHECK_CANCELLED:
        case ConnectionStatus.HEALTH_CHECK_FAILED:
        case ConnectionStatus.HEALTH_CHECK_SUCCEEDED:
        case ConnectionStatus.NOT_STARTED:
        case ConnectionStatus.OAUTH_CODE_RECEIVED:
        case ConnectionStatus.PKCE_GENERATED:
            return true;
        case ConnectionStatus.AUTH_STARTED:
        case ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED:
        case ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED:
        case ConnectionStatus.HEALTH_CHECK_STARTED:
        case ConnectionStatus.PKCE_GENERATION_STARTED:
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK:
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW:
            return false;
    }
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

export type AttachedDatabaseStateWithoutId = Omit<AttachedDatabaseState, "databaseId">;

export const DELETE_ATTACHED_DATABASE = Symbol('DELETE_ATTACHED_DATABASE');
export const RESET_ATTACHED_DATABASE = Symbol('RESET_ATTACHED_DATABASE');
export const SWITCH_CONNECTOR_TYPE = Symbol('SWITCH_CONNECTOR_TYPE');
export const SET_ATTACHED_DATABASE_ACTIVE = Symbol('SET_ATTACHED_DATABASE_ACTIVE');
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

export type CatalogAction =
    | VariantKind<typeof SET_CATALOG_SCRIPT, dashql.DashQLScript>
    | VariantKind<typeof APPLY_CATALOG_CHANGES, dashql.buffers.catalog.CatalogChangeT[]>
    | VariantKind<typeof UPDATE_CATALOG, [number, CatalogUpdateTaskState]>
    | VariantKind<typeof CATALOG_UPDATE_REGISTER_QUERY, [number, number]>
    | VariantKind<typeof CATALOG_UPDATE_SCHEMA_SCRIPT, [number]>
    | VariantKind<typeof CATALOG_UPDATE_CANCELLED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_FAILED, [number, Error]>
    | VariantKind<typeof CATALOG_UPDATE_SUCCEEDED, [number]>
    | VariantKind<typeof CATALOG_UPDATE_PARTIALLY_SUCCEEDED, [number, Error]>
    ;

export type AttachedDatabaseAction =
    | VariantKind<typeof SET_CONNECTION_DRAFT, ConnectionParams>
    | VariantKind<typeof DISCARD_CONNECTION_DRAFT, null>
    | VariantKind<typeof COMMIT_CONNECTION_PARAMS, ConnectionParams>
    | VariantKind<typeof DELETE_ATTACHED_DATABASE, null>
    | VariantKind<typeof RESET_ATTACHED_DATABASE, null>
    | VariantKind<typeof SWITCH_CONNECTOR_TYPE, ConnectorType>
    | VariantKind<typeof SET_ATTACHED_DATABASE_ACTIVE, null>
    | CatalogAction
    | QueryExecutionAction
    | HyperConnectorAction
    | TrinoConnectorAction
    | SalesforceConnectionStateAction
    ;

export function reduceAttachedDatabaseState(state: AttachedDatabaseState, action: AttachedDatabaseAction, storage: StorageWriter, logger: Logger): AttachedDatabaseState {
    switch (action.type) {
        case SET_CONNECTION_DRAFT: {
            if (getConnectionInfoFromParams(action.value)?.connectorType !== state.connectorInfo.connectorType) return state;
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
            return reduceCatalogAction(state, action, storage);

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

        // RESET_ATTACHED_DATABASE is a bit special since we want to clean up our details as well
        case RESET_ATTACHED_DATABASE: {
            cancelConnectionSetup(state.databaseId);
            // Reset the DashQL catalog
            invalidateCatalogBatch(state.catalog);
            for (const task of state.catalogUpdates.tasksRunning.values()) {
                task.cancellation.abort(new DOMException('Attached database was reset', 'AbortError'));
            }
            state.catalog.clear();

            // XXX Cancel currently running queries

            // Cleanup query executions and catalog
            const cleaned: AttachedDatabaseState = {
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
            // Cleanup the details
            let newState: AttachedDatabaseState | null = null;
            switch (state.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    newState = reduceSalesforceConnectionState(cleaned, action as SalesforceConnectionStateAction, storage);
                    break;
                case HYPER_CONNECTOR:
                    newState = reduceHyperConnectorState(cleaned, action as HyperConnectorAction, storage);
                    break;
                case TRINO_CONNECTOR:
                    newState = reduceTrinoConnectorState(cleaned, action as TrinoConnectorAction, storage);
                    break;
            }

            // Cleaning up details is best-effort. No need to check if RESET was actually consumed
            newState = newState ?? cleaned;

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
            const newSig = computeNewConnectionSignatureFromDetails(newDetails);
            return {
                ...state,
                connectorInfo: newInfo,
                connectionSignature: newConnectionSignature(newSig, state.connectionSignature.signatures, null),
                details: newDetails,
                params: getConnectionParamsFromStateDetails(newDetails)!,
                paramsDraft: undefined,
                setupAttemptParams: undefined,
                setupAttemptDraft: undefined,
            };
        }

        // SET_ATTACHED_DATABASE_ACTIVE marks the database as active.
        // Once active, storage writes are enabled for both connection and session scripts state.
        case SET_ATTACHED_DATABASE_ACTIVE: {
            if (state.active) {
                return state;
            }
            return { ...state, active: true };
        }

        /// DELETE_ATTACHED_DATABASE deletes the attached database state
        case DELETE_ATTACHED_DATABASE: {
            cancelConnectionSetup(state.databaseId);
            invalidateCatalogBatch(state.catalog);
            for (const task of state.catalogUpdates.tasksRunning.values()) {
                task.cancellation.abort(new DOMException('Attached database was deleted', 'AbortError'));
            }
            // XXX This must not be done if there are still sessions referencing the connection!

            // XXX Cancel currently running queries

            // Cleanup query executions and catalog
            const cleaned: AttachedDatabaseState = {
                ...state,
                connectionStatus: ConnectionStatus.NOT_STARTED,
                connectionHealth: ConnectionHealth.NOT_STARTED,
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

            // Dispatch to the individual state detail handlers
            let newState: AttachedDatabaseState | null = null;
            switch (state.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    newState = reduceSalesforceConnectionState(cleaned, action as SalesforceConnectionStateAction, storage);
                    break;
                case HYPER_CONNECTOR:
                    newState = reduceHyperConnectorState(cleaned, action as HyperConnectorAction, storage);
                    break;
                case TRINO_CONNECTOR:
                    newState = reduceTrinoConnectorState(cleaned, action as TrinoConnectorAction, storage);
                    break;
            }

            // Cleaning up details is best-effort. No need to check if RESET was actually consumed
            newState = newState ?? cleaned;

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
            // Dispatch to the individual state detail handlers
            let newState: AttachedDatabaseState | null = null;
            switch (state.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    newState = reduceSalesforceConnectionState(state, action as SalesforceConnectionStateAction, storage);
                    break;
                case HYPER_CONNECTOR:
                    newState = reduceHyperConnectorState(state, action as HyperConnectorAction, storage);
                    break;
                case TRINO_CONNECTOR:
                    newState = reduceTrinoConnectorState(state, action as TrinoConnectorAction, storage);
                    break;
            }
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

/// Apply the catalog changes of executed statements to the relation descriptor and record them as SQL.
/// The changes are qualified with the default database and schema of the connection.
function applyCatalogChanges(state: AttachedDatabaseState, changes: dashql.buffers.catalog.CatalogChangeT[], logger: Logger): AttachedDatabaseState {
    if (changes.length === 0) return state;
    try {
        const qualified = state.instance.qualifyCatalogChanges(changes, catalogNameDefaults(state.details));
        state.catalog.applyCatalogChanges(state.catalogRelationScript.catalog_entry_id, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, qualified);
        const catalogChangesSql = state.instance.appendCatalogChangesSql(state.catalogChangesSql, qualified);
        logger.info('Applied catalog changes of executed statements', {
            databaseId: state.databaseId,
            changes: qualified.length.toString(),
        }, LOG_CTX);
        return { ...state, catalogChangesSql };
    } catch (e: unknown) {
        logger.error('Failed to apply catalog changes of executed statements', {
            databaseId: state.databaseId,
            error: stringifyError(e),
        }, LOG_CTX);
        return state;
    }
}

export function createConnectionMetrics(): connection.ConnectionMetrics {
    return createQueryExecutionMetrics();
}

export function createAttachedDatabaseState(dql: dashql.DashQL, info: ConnectorInfo, connSigs: ConnectionSignatureMap, details: ConnectionStateDetailsVariant): AttachedDatabaseStateWithoutId {
    const catalog = dql.createCatalog();
    const catalogRelationScript = dql.createScript(catalog);
    catalogRelationScript.replaceText(generateCatalogScriptHeader(CatalogSource.Unknown));
    const catalogFunctionScript = dql.createScript(catalog);
    catalogFunctionScript.replaceText(generateFunctionScriptHeader(CatalogSource.Unknown));
    const connSig = computeNewConnectionSignatureFromDetails(details);
    return {
        instance: dql,
        active: false,
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectorInfo: info,
        connectionSignature: newConnectionSignature(connSig, connSigs, null),
        metrics: createConnectionMetrics(),
        details,
        params: getConnectionParamsFromStateDetails(details)!,
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

export function createAttachedDatabaseStateForType(dql: dashql.DashQL, type: ConnectorType, connSigs: ConnectionSignatureMap): AttachedDatabaseStateWithoutId {
    const connInfo = CONNECTOR_INFOS[type as number];
    const connMetrics = createConnectionMetrics();
    const connDetails = createConnectionStateDetails(type);
    const connSig = computeNewConnectionSignatureFromDetails(connDetails);

    const catalog = dql.createCatalog();
    const catalogRelationScript = dql.createScript(catalog);
    catalogRelationScript.replaceText(generateCatalogScriptHeader(CatalogSource.Unknown));
    const catalogFunctionScript = dql.createScript(catalog);
    catalogFunctionScript.replaceText(generateFunctionScriptHeader(CatalogSource.Unknown));
    return {
        instance: dql,
        active: false,
        connectionStatus: ConnectionStatus.NOT_STARTED,
        connectionHealth: ConnectionHealth.NOT_STARTED,
        connectorInfo: connInfo,
        connectionSignature: newConnectionSignature(connSig, connSigs, null),
        metrics: connMetrics,
        details: connDetails,
        params: getConnectionParamsFromStateDetails(connDetails)!,
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

/// Apply catalog files read from storage without scheduling a persistence write. The database
/// object and catalog remain alive, so active channels, query history and consumers keep stable
/// references while session scripts are subsequently re-analyzed against the refreshed catalog.
export function replaceAttachedDatabaseCatalogFromStorage(
    state: AttachedDatabaseState,
    schemaSql: string | null,
    functionsSql: string | null,
): boolean {
    const entries: CatalogBatchEntry[] = [];
    const replace = (script: core.DashQLScript, sql: string | null, emptyText: () => string) => {
        const text = sql ?? emptyText();
        const published = state.catalog.containsEntryId(script.catalog_entry_id);
        if (sql == null && catalogScriptHasNoStatements(script.toString())) {
            return;
        }
        if (script.toString() === text && published) {
            return;
        }
        entries.push({ script, text, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK });
    };
    replace(state.catalogRelationScript, schemaSql, () => generateCatalogScriptHeader(CatalogSource.Unknown));
    replace(state.catalogFunctionScript, functionsSql, () => generateFunctionScriptHeader(CatalogSource.Unknown));
    const changed = entries.length > 0;
    if (changed) {
        publishCatalogBatchSync(state.instance, state.catalog, entries);
        state.catalogUpdates.restoredAt = new Date();
        // The republished relation descriptor lacks the changes of executed statements
        if (state.catalogChangesSql.length > 0) {
            state.catalog.applyCatalogChangesSql(state.catalogRelationScript.catalog_entry_id, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, state.catalogChangesSql);
        }
    }
    return changed;
}

/// Generated empty catalog files contain only comments and whitespace. Treat those as equivalent to
/// an absent file so unrelated session watcher events do not report a false external catalog edit.
export function attachedDatabaseCatalogMatchesStorage(
    state: AttachedDatabaseState,
    schemaSql: string | null,
    functionsSql: string | null,
): boolean {
    const matches = (script: core.DashQLScript, sql: string | null) => {
        const text = script.toString();
        const textMatches = sql == null ? catalogScriptHasNoStatements(text) : text === sql;
        return textMatches && (catalogScriptHasNoStatements(text) || state.catalog.containsEntryId(script.catalog_entry_id));
    };
    return matches(state.catalogRelationScript, schemaSql)
        && matches(state.catalogFunctionScript, functionsSql);
}

export function catalogFileMatchesStorage(script: core.DashQLScript, sql: string | null): boolean {
    return sql == null ? catalogScriptHasNoStatements(script.toString()) : script.toString() === sql;
}

function catalogScriptHasNoStatements(sql: string): boolean {
    return sql.split('\n').every(line => line.trim() === '' || line.trimStart().startsWith('--'));
}

export function computeAttachedDatabaseSignature(state: AttachedDatabaseState, hasher: Hasher) {
    return computeConnectionSignatureFromDetails(state.details, hasher);
}
