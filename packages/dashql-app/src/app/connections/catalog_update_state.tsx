import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_SCHEMA_SCRIPT,
    CATALOG_UPDATE_REGISTER_QUERY,
    CATALOG_UPDATE_PARTIALLY_SUCCEEDED,
    CATALOG_UPDATE_SUCCEEDED,
    CatalogAction,
    ConnectionState,
    SET_CATALOG_SCRIPT,
    UPDATE_CATALOG,
} from './connection_state.js';

/// Rank used for the default descriptor pool loaded by app and shell catalogs.
export const CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK = 9999;

export enum CatalogUpdateVariant {
    FULL_CATALOG_REFRESH
}

export enum CatalogUpdateTaskStatus {
    STARTED = 0,
    SUCCEEDED = 1,
    FAILED = 2,
    CANCELLED = 3,
    PARTIALLY_SUCCEEDED = 4,
}
export const CATALOG_UPDATE_TASK_STATUS_NAMES: string[] = [
    "Started",
    "Succeeded",
    "Failed",
    "Cancelled",
    "Partially Succeeded",
];

export interface CatalogUpdateTaskState {
    /// The task key
    taskId: number;
    /// The catalog update variant
    taskVariant: CatalogUpdateVariant;
    /// The status
    status: CatalogUpdateTaskStatus;
    /// The cancellation signal
    cancellation: AbortController;
    /// The queries
    queries: number[];
    /// The loading error (if any)
    error: Error | null;
    /// The time at which the loading started (if any)
    startedAt: Date | null;
    /// The time at which the loading finishe (if any)
    finishedAt: Date | null;
    /// The time at which the task was last updated
    lastUpdateAt: Date | null;
}

export function isCatalogRefreshRunning(connection: ConnectionState | null): boolean {
    if (connection == null) return false;
    const refreshId = connection.catalogUpdates.currentFullRefresh;
    return refreshId != null && connection.catalogUpdates.tasksRunning.has(refreshId);
}

export function reduceCatalogAction(state: ConnectionState, action: CatalogAction): ConnectionState {
    const now = new Date();

    if (action.type == UPDATE_CATALOG) {
        const [updateId, update] = action.value;
        state.catalogUpdates.tasksRunning.set(updateId, update);
        return {
            ...state,
            catalogUpdates: {
                ...state.catalogUpdates,
                tasksRunning: state.catalogUpdates.tasksRunning,
                currentFullRefresh: update.taskVariant == CatalogUpdateVariant.FULL_CATALOG_REFRESH
                    ? updateId
                    : state.catalogUpdates.currentFullRefresh
            },
        };
    }

    // SET_CATALOG_SCRIPT doesn't involve catalog updates
    if (action.type == SET_CATALOG_SCRIPT) {
        return state;
    }

    const updateId = (action.value as [number, ...any])[0];
    let update = state.catalogUpdates.tasksRunning.get(updateId);
    if (!update) {
        return state;
    }
    switch (action.type) {
        case CATALOG_UPDATE_REGISTER_QUERY: {
            update = {
                ...update,
                queries: [...update.queries, action.value[1]],
                lastUpdateAt: now,
            };
            state.catalogUpdates.tasksRunning.set(updateId, update);
            return {
                ...state,
                catalogUpdates: {
                    ...state.catalogUpdates,
                    tasksRunning: state.catalogUpdates.tasksRunning,
                }
            };
        }
        case CATALOG_UPDATE_SCHEMA_SCRIPT: {
            update = {
                ...update,
                lastUpdateAt: now,
            };
            state.catalogUpdates.tasksRunning.set(updateId, update);
            return {
                ...state,
                catalogUpdates: {
                    ...state.catalogUpdates,
                    tasksRunning: state.catalogUpdates.tasksRunning,
                }
            };
        }
        case CATALOG_UPDATE_CANCELLED:
            update = {
                ...update,
                status: CatalogUpdateTaskStatus.CANCELLED,
                error: action.value[1],
                finishedAt: now,
                lastUpdateAt: now,
            };
            state.catalogUpdates.tasksRunning.delete(updateId);
            state.catalogUpdates.tasksFinished.set(updateId, update);
            return {
                ...state,
                catalogUpdates: {
                    tasksRunning: state.catalogUpdates.tasksRunning,
                    tasksFinished: state.catalogUpdates.tasksFinished,
                    restoredAt: state.catalogUpdates.restoredAt,
                    currentFullRefresh: state.catalogUpdates.currentFullRefresh,
                    lastFullRefresh: state.catalogUpdates.currentFullRefresh === updateId
                        ? updateId : state.catalogUpdates.lastFullRefresh,
                }
            };
        case CATALOG_UPDATE_FAILED:
            update = {
                ...update,
                status: CatalogUpdateTaskStatus.FAILED,
                error: action.value[1],
                finishedAt: now,
                lastUpdateAt: now,
            };
            state.catalogUpdates.tasksRunning.delete(updateId);
            state.catalogUpdates.tasksFinished.set(updateId, update);
            return {
                ...state,
                catalogUpdates: {
                    tasksRunning: state.catalogUpdates.tasksRunning,
                    tasksFinished: state.catalogUpdates.tasksFinished,
                    restoredAt: state.catalogUpdates.restoredAt,
                    currentFullRefresh: state.catalogUpdates.currentFullRefresh,
                    lastFullRefresh: state.catalogUpdates.currentFullRefresh === updateId
                        ? updateId : state.catalogUpdates.lastFullRefresh,
                }
            };
        case CATALOG_UPDATE_SUCCEEDED:
        case CATALOG_UPDATE_PARTIALLY_SUCCEEDED:
            update = {
                ...update,
                status: action.type === CATALOG_UPDATE_SUCCEEDED
                    ? CatalogUpdateTaskStatus.SUCCEEDED
                    : CatalogUpdateTaskStatus.PARTIALLY_SUCCEEDED,
                error: action.type === CATALOG_UPDATE_PARTIALLY_SUCCEEDED ? action.value[1] : null,
                finishedAt: now,
                lastUpdateAt: now,
            };
            state.catalogUpdates.tasksRunning.delete(updateId);
            state.catalogUpdates.tasksFinished.set(updateId, update);
            // The refreshed relation script describes the catalog, the changes of earlier statements are part of it
            return {
                ...state,
                catalogChangesSql: '',
                catalogUpdates: {
                    tasksRunning: state.catalogUpdates.tasksRunning,
                    tasksFinished: state.catalogUpdates.tasksFinished,
                    restoredAt: state.catalogUpdates.restoredAt,
                    currentFullRefresh: state.catalogUpdates.currentFullRefresh,
                    lastFullRefresh: state.catalogUpdates.currentFullRefresh === updateId
                        ? updateId : state.catalogUpdates.lastFullRefresh,
                }
            };
        default:
            return state;
    }
}
