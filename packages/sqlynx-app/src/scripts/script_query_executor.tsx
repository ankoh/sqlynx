import * as React from 'react';
import Immutable from 'immutable';

import { useSelectedScriptState, useSelectedScriptStateDispatch } from '../scripts/script_state_provider';
import {
    QueryExecutionResponseStream,
    QueryExecutionTaskState,
    QueryExecutionTaskStatus,
    QueryExecutionTaskVariant,
} from '../connectors/query_execution';
import { useSalesforceAPI } from '../connectors/salesforce_connector';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state';
import { ConnectorType, SALESFORCE_DATA_CLOUD } from '../connectors/connector_info';
import {
    QUERY_EXECUTION_ACCEPTED,
    QUERY_EXECUTION_CANCELLED,
    QUERY_EXECUTION_FAILED,
    QUERY_EXECUTION_PROGRESS_UPDATED,
    QUERY_EXECUTION_RECEIVED_BATCH,
    QUERY_EXECUTION_RECEIVED_SCHEMA,
    QUERY_EXECUTION_STARTED,
    QUERY_EXECUTION_SUCCEEDED,
} from './script_state_reducer';
import { ScriptKey } from './script_state';

export const ScriptQueryExecutor = (props: { children?: React.ReactElement }) => {
    const state = useSelectedScriptState();
    const dispatch = useSelectedScriptStateDispatch();
    const salesforceAPI = useSalesforceAPI();
    const salesforceAuth = useSalesforceAuthState();

    React.useEffect(() => {
        if (!state || !state.queryExecutionRequested) {
            return;
        }

        let task: QueryExecutionTaskVariant;
        switch (state.connectorInfo.connectorType) {
            case ConnectorType.SALESFORCE_DATA_CLOUD:
                task = {
                    type: SALESFORCE_DATA_CLOUD,
                    value: {
                        api: salesforceAPI,
                        accessToken: salesforceAuth.dataCloudAccessToken!,
                        scriptText: state.scripts[ScriptKey.MAIN_SCRIPT]?.script?.toString() ?? '',
                    },
                };
                break;
            case ConnectorType.LOCAL_SCRIPT:
            case ConnectorType.HYPER_DATABASE:
                console.warn(
                    `script query executor does not support connector ${state.connectorInfo.connectorType} yet`,
                );
                return;
        }

        // Accept the query and clear the request
        const initialState: QueryExecutionTaskState = {
            task,
            status: QueryExecutionTaskStatus.ACCEPTED,
            cancellation: new AbortController(),
            resultStream: null,
            error: null,
            startedAt: new Date(),
            finishedAt: null,
            lastUpdatedAt: null,
            latestProgressUpdate: null,
            resultSchema: null,
            resultBatches: Immutable.List(),
        };
        dispatch({
            type: QUERY_EXECUTION_ACCEPTED,
            value: initialState,
        });

        // Helper to subscribe to progress updates
        const progressUpdater = async (resultStream: QueryExecutionResponseStream) => {
            while (true) {
                const update = await resultStream.nextProgressUpdate();
                if (update == null) {
                    break;
                }
                dispatch({
                    type: QUERY_EXECUTION_PROGRESS_UPDATED,
                    value: update,
                });
            }
        };
        // Helper to subscribe to result batches
        const resultReader = async (resultStream: QueryExecutionResponseStream) => {
            const schema = await resultStream.getSchema();
            if (schema == null) {
                return;
            }
            dispatch({
                type: QUERY_EXECUTION_RECEIVED_SCHEMA,
                value: schema,
            });
            while (true) {
                const batch = await resultStream.nextRecordBatch();
                if (batch == null) {
                    break;
                }
                dispatch({
                    type: QUERY_EXECUTION_RECEIVED_BATCH,
                    value: batch,
                });
            }
        };
        // Execute the query and consume the results
        const run = async () => {
            try {
                // Start the query
                let resultStream: QueryExecutionResponseStream;
                switch (task.type) {
                    case SALESFORCE_DATA_CLOUD: {
                        const req = task.value;
                        resultStream = req.api.executeQuery(req.scriptText, req.accessToken);
                        break;
                    }
                }
                dispatch({
                    type: QUERY_EXECUTION_STARTED,
                    value: resultStream,
                });
                // Subscribe to progress and result messages
                const progress = progressUpdater(resultStream);
                const results = resultReader(resultStream);
                await Promise.all([results, progress]);
                dispatch({
                    type: QUERY_EXECUTION_SUCCEEDED,
                    value: null,
                });
            } catch (e: any) {
                if ((e.message = 'AbortError')) {
                    dispatch({
                        type: QUERY_EXECUTION_CANCELLED,
                        value: null,
                    });
                } else {
                    dispatch({
                        type: QUERY_EXECUTION_FAILED,
                        value: e,
                    });
                }
            }
        };
        run();
    }, [state?.queryExecutionRequested]);

    return props.children;
};
