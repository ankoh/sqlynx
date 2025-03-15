import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_LOAD_DESCRIPTORS,
    CATALOG_UPDATE_REGISTER_QUERY,
    CATALOG_UPDATE_SUCCEEDED,
    CatalogAction,
    ConnectionState,
    UPDATE_CATALOG,
} from './connection_state.js';

/// The default descriptor pool of the catalog
export const CATALOG_DEFAULT_DESCRIPTOR_POOL = 42;
/// The rank for catalog default descriptor pool.
/// We match catalog entries ordered by rank.
/// A higher rank is matched later.
export const CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK = 9999;

export enum CatalogUpdateVariant {
    FULL_CATALOG_REFRESH
}

export enum CatalogUpdateTaskStatus {
    STARTED = 0,
    SUCCEEDED = 1,
    FAILED = 2,
    CANCELLED = 3,
}
export const CATALOG_UPDATE_TASK_STATUS_NAMES: string[] = [
    "Started",
    "Succeeded",
    "Failed",
    "Cancelled",
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
                lastFullRefresh: update.taskVariant == CatalogUpdateVariant.FULL_CATALOG_REFRESH
                    ? updateId
                    : state.catalogUpdates.lastFullRefresh
            },
        };
    }
    const updateId = action.value[0];
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
        case CATALOG_UPDATE_LOAD_DESCRIPTORS: {
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
                    lastFullRefresh: updateId,
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
                    lastFullRefresh: updateId,
                }
            };
        case CATALOG_UPDATE_SUCCEEDED:
            update = {
                ...update,
                status: CatalogUpdateTaskStatus.SUCCEEDED,
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
                    lastFullRefresh: updateId,
                }
            };
    }
}
