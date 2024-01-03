import React from 'react';

import { SQLynxCatalog } from '@ankoh/sqlynx';
import { SalesforceConnectorInterface, SalesforceDataCloudAccessToken } from './salesforce_api_client';
import { useSalesforceAuthState } from './salesforce_auth_state';
import { useSalesforceConnector } from './salesforce_connector';
import { useCatalogLoader } from './catalog_loader';

export const UPDATE_SALESFORCE_DATA_CLOUD_METADATA = Symbol('UPDATE_SALESFORCE_DATA_CLOUD_METADATA');

export interface UpdateDataCloudMetadataTask {
    api: SalesforceConnectorInterface;
    accessToken: SalesforceDataCloudAccessToken;
}

export async function updateDataCloudMetadata(
    catalog: SQLynxCatalog,
    task: UpdateDataCloudMetadataTask,
    cancellation: AbortController,
): Promise<void> {
    const result = await task.api.getDataCloudMetadata(task.accessToken, cancellation.signal);
    catalog.clear();
}

interface Props {
    children?: React.ReactElement;
}

export const SalesforceCatalogLoader: React.FC<Props> = (props: Props) => {
    const connector = useSalesforceConnector();
    const authState = useSalesforceAuthState();
    const loadCatalog = useCatalogLoader();
    React.useEffect(() => {
        if (!connector || !authState.dataCloudAccessToken) return;
        loadCatalog({
            type: UPDATE_SALESFORCE_DATA_CLOUD_METADATA,
            value: {
                api: connector,
                accessToken: authState.dataCloudAccessToken,
            },
        });
    }, [connector, authState.dataCloudAccessToken]);
    return props.children;
};
