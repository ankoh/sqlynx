import * as React from 'react';

import { useScriptState, useScriptStateDispatch } from '../scripts/script_state_provider';
import { updateDataCloudCatalog } from '../connectors/salesforce_catalog_update';
import {
    CatalogUpdateTaskState,
    CatalogUpdateTaskStatus,
    CatalogUpdateTaskVariant,
    FULL_CATALOG_REFRESH,
} from '../connectors/catalog_update';
import { SALESFORCE_DATA_CLOUD } from '../connectors/connector_info';
import { useSalesforceAPI } from '../connectors/salesforce_connector';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state';
import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_STARTED,
    CATALOG_UPDATE_SUCCEEDED,
} from './script_state_reducer';

export const ScriptCatalogLoader = (props: { children?: React.ReactElement }) => {
    const state = useScriptState();
    const dispatch = useScriptStateDispatch();
    const salesforceAPI = useSalesforceAPI();
    const salesforceAuth = useSalesforceAuthState();

    React.useEffect(() => {
        if (!state.catalog) {
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
                            accessToken: salesforceAuth.dataCloudAccessToken!,
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
    }, [state.catalog, state.catalogUpdateRequests]);

    return props.children;
};
