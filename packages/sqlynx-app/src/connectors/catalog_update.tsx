import { VariantKind } from '../utils';
import { SALESFORCE_DATA_CLOUD } from './connector_info';
import { SalesforceAPIClientInterface, SalesforceDataCloudAccessToken } from './salesforce_api_client';

export type CatalogUpdateTaskVariant = VariantKind<typeof SALESFORCE_DATA_CLOUD, UpdateDataCloudMetadataTask>;

export interface UpdateDataCloudMetadataTask {
    api: SalesforceAPIClientInterface;
    accessToken: SalesforceDataCloudAccessToken;
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
    task: CatalogUpdateTaskVariant;
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
