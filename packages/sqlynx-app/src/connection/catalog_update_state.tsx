import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_REGISTER_QUERY,
    CATALOG_UPDATE_SUCCEEDED,
    CatalogAction,
    ConnectionState,
    UPDATE_CATALOG,
} from './connection_state.js';

export enum CatalogUpdateVariant {
    FULL_CATALOG_REFRESH
}

export enum CatalogUpdateTaskStatus {
    STARTED = 0,
    SUCCEEDED = 2,
    FAILED = 3,
    CANCELLED = 4,
}

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
                    lastFullRefresh: null,
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
                    lastFullRefresh: null,
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
                    lastFullRefresh: null,
                }
            };
    }
}
