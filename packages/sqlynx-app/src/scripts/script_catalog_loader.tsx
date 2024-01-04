import * as React from 'react';

import { useScriptState, useScriptStateDispatch } from '../scripts/script_state_provider';
import {
    UPDATE_SALESFORCE_DATA_CLOUD_METADATA,
    updateDataCloudMetadata,
} from '../connectors/salesforce_metadata_catalog';
import { CatalogUpdateTaskState, CatalogUpdateTaskStatus } from '../connectors/catalog_update';
import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_STARTED,
    CATALOG_UPDATE_SUCCEEDED,
} from './script_state_reducer';

export const ScriptCatalogLoader = (props: { children?: React.ReactElement }) => {
    const state = useScriptState();
    const dispatch = useScriptStateDispatch();

    React.useEffect(() => {
        if (!state.catalog) {
            return;
        }
        const catalog = state.catalog;
        const states: CatalogUpdateTaskState[] = [];
        const startedAt = new Date();

        for (const [taskId, task] of state.catalogUpdateRequests) {
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

        const run = async () => {
            for (const taskState of states) {
                try {
                    switch (taskState.task.type) {
                        case UPDATE_SALESFORCE_DATA_CLOUD_METADATA: {
                            await updateDataCloudMetadata(catalog, taskState.task.value, taskState.cancellation);
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
            }
        };
        run();
    }, [state.catalog, state.catalogUpdateRequests]);

    return props.children;
};
