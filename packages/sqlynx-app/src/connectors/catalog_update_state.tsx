import * as sqlynx from '@ankoh/sqlynx-core';

import { VariantKind } from '../utils/index.js';
import { HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR } from './connector_info.js';
import { SalesforceAPIClientInterface, SalesforceDataCloudAccessToken } from './salesforce/salesforce_api_client.js';
import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_SUCCEEDED,
    CatalogAction,
    ConnectionState,
    UPDATE_CATALOG,
} from './connection_state.js';
import { HyperDatabaseChannel } from '../platform/hyperdb_client.js';

export const FULL_CATALOG_REFRESH = Symbol();

export type CatalogUpdateVariant = VariantKind<typeof FULL_CATALOG_REFRESH, null>;

export type CatalogTaskVariant =
    | VariantKind<typeof SALESFORCE_DATA_CLOUD_CONNECTOR, UpdateSalesforceMetadataTask>
    | VariantKind<typeof HYPER_GRPC_CONNECTOR, UpdateHyperCatalogTask>;

export interface UpdateSalesforceMetadataTask {
    /// The target catalog
    catalog: sqlynx.SQLynxCatalog;
    /// The salesforce api client
    api: SalesforceAPIClientInterface;
    /// The access token
    accessToken: SalesforceDataCloudAccessToken;
}

export interface UpdateHyperCatalogTask {
    /// The target catalog
    catalog: sqlynx.SQLynxCatalog;
    /// The channel
    hyperChannel: HyperDatabaseChannel;
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
    /// The task
    task: CatalogTaskVariant;
    /// The status
    status: CatalogUpdateTaskStatus;
    /// The cancellation signal
    cancellation: AbortController;
    /// The loading error (if any)
    error: Error | null;
    /// The time at which the loading started (if any)
    startedAt: Date | null;
    /// The time at which the loading finishe (if any)
    finishedAt: Date | null;
}

export function reduceCatalogAction(state: ConnectionState, action: CatalogAction): ConnectionState {
    const now = new Date();

    if (action.type == UPDATE_CATALOG) {
        const [updateId, update] = action.value;
        state.catalogUpdatesRunning.set(updateId, update);
        return { ...state };
    }
    const updateId = action.value[0];
    let update = state.catalogUpdatesRunning.get(updateId);
    if (!update) {
        return state;
    }
    switch (action.type) {
        case CATALOG_UPDATE_CANCELLED:
            update = {
                ...update,
                status: CatalogUpdateTaskStatus.CANCELLED,
                error: action.value[1],
                finishedAt: now,
            };
            state.catalogUpdatesRunning.delete(updateId);
            state.catalogUpdatesFinished.set(updateId, update);
            return { ...state };
        case CATALOG_UPDATE_FAILED:
            update = {
                ...update,
                status: CatalogUpdateTaskStatus.FAILED,
                error: action.value[1],
                finishedAt: now,
            };
            state.catalogUpdatesRunning.delete(updateId);
            state.catalogUpdatesFinished.set(updateId, update);
            return { ...state };
        case CATALOG_UPDATE_SUCCEEDED:
            update = {
                ...update,
                status: CatalogUpdateTaskStatus.SUCCEEDED,
                finishedAt: now,
            };
            state.catalogUpdatesRunning.delete(updateId);
            state.catalogUpdatesFinished.set(updateId, update);
            return { ...state };
    }
}
