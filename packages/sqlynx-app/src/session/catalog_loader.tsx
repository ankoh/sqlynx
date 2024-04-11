import * as React from 'react';

import { useActiveSessionState, useActiveSessionStateDispatch } from '../session/session_state_provider.js';
import { updateDataCloudCatalog } from '../connectors/salesforce_catalog_update.js';
import {
    CatalogUpdateTaskState,
    CatalogUpdateTaskStatus,
    CatalogUpdateTaskVariant,
    FULL_CATALOG_REFRESH,
} from '../connectors/catalog_update.js';
import { SALESFORCE_DATA_CLOUD } from '../connectors/connector_info.js';
import { useSalesforceAPI } from '../connectors/salesforce_connector.js';
import { useSalesforceConnectionId } from '../connectors/salesforce_auth_state.js';
import { useConnectionState } from '../connectors/connection_manager.js';
import { SalesforceConnectorState } from '../connectors/connection_state.js';
import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_STARTED,
    CATALOG_UPDATE_SUCCEEDED,
} from './session_state_reducer.js';

export const CatalogLoader = (props: { children?: React.ReactElement }) => {
    const state = useActiveSessionState();
    const dispatch = useActiveSessionStateDispatch();
    const salesforceAPI = useSalesforceAPI();
    const connectionId = useSalesforceConnectionId();
    const [connection, _setConnection] = useConnectionState<SalesforceConnectorState>(connectionId);

    React.useEffect(() => {
        if (!state?.catalog || !connection) {
            return;
        }
        const catalog = state.catalog;
        const states: CatalogUpdateTaskState[] = [];
        const startedAt = new Date();

        for (const [taskId, requestVariant] of state.catalogUpdateRequests) {
            let task: CatalogUpdateTaskVariant;
            switch (requestVariant.type) {
                case FULL_CATALOG_REFRESH:
                    task = {
                        type: SALESFORCE_DATA_CLOUD,
                        value: {
                            api: salesforceAPI,
                            accessToken: connection.auth.dataCloudAccessToken!,
                        },
                    };
                    break;
            }

            const cancellation = new AbortController();
            states.push({
                taskId,
                task,
                status: CatalogUpdateTaskStatus.STARTED,
                cancellation: cancellation,
                error: null,
                startedAt: startedAt,
                finishedAt: null,
            });
        }
        dispatch({
            type: CATALOG_UPDATE_STARTED,
            value: states,
        });

        const processAll = async () => {
            const updates = [];
            for (const taskState of states) {
                const update = async () => {
                    try {
                        switch (taskState.task.type) {
                            case SALESFORCE_DATA_CLOUD: {
                                const task = taskState.task.value;
                                const metadata = await task.api.getDataCloudMetadata(
                                    task.accessToken,
                                    taskState.cancellation.signal,
                                );
                                updateDataCloudCatalog(catalog, metadata);
                                break;
                            }
                        }
                        dispatch({
                            type: CATALOG_UPDATE_SUCCEEDED,
                            value: taskState.taskId,
                        });
                    } catch (e: any) {
                        if ((e.message = 'AbortError')) {
                            dispatch({
                                type: CATALOG_UPDATE_CANCELLED,
                                value: taskState.taskId,
                            });
                        } else {
                            dispatch({
                                type: CATALOG_UPDATE_FAILED,
                                value: [taskState.taskId, e],
                            });
                        }
                    }
                };
                updates.push(update());
            }
            await Promise.all(updates);
        };
        processAll();
    }, [state?.catalog, state?.catalogUpdateRequests]);

    return props.children;
};
