import * as React from 'react';
import Immutable from 'immutable';

import { useCurrentSessionState } from './current_session.js';
import { useConnectionState } from '../connectors/connection_registry.js';
import {
    QueryExecutionResponseStream,
    QueryExecutionTaskState,
    QueryExecutionStatus,
    QueryExecutionTaskVariant,
} from '../connectors/query_execution.js';
import { useSalesforceAPI, useSalesforceConnectionId } from '../connectors/salesforce_connector.js';
import { asSalesforceConnection } from '../connectors/connection_state.js';
import { ConnectorType, SALESFORCE_DATA_CLOUD_CONNECTOR } from '../connectors/connector_info.js';
import {
    QUERY_EXECUTION_ACCEPTED,
    QUERY_EXECUTION_CANCELLED,
    QUERY_EXECUTION_FAILED,
    QUERY_EXECUTION_PROGRESS_UPDATED,
    QUERY_EXECUTION_RECEIVED_BATCH,
    QUERY_EXECUTION_RECEIVED_SCHEMA,
    QUERY_EXECUTION_STARTED,
    QUERY_EXECUTION_SUCCEEDED,
} from './session_state_reducer.js';
import { ScriptKey } from './session_state.js';

export const QueryExecutor = (props: { children?: React.ReactElement }) => {
    const [state, dispatch] = useCurrentSessionState();
    const salesforceAPI = useSalesforceAPI();

    const connectionId = useSalesforceConnectionId();
    const [connection, _setConnection] = useConnectionState(connectionId);

    React.useEffect(() => {
        if (!state || !state.queryExecutionRequested || !connection) {
            return;
        }

        let task: QueryExecutionTaskVariant;
        switch (state.connectorInfo.connectorType) {
            case ConnectorType.SALESFORCE_DATA_CLOUD: {
                const sfconn = asSalesforceConnection(connection)!;
                task = {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        api: salesforceAPI,
                        authParams: sfconn.authParams!,
                        dataCloudAccessToken: sfconn.dataCloudAccessToken!,
                        scriptText: state.scripts[ScriptKey.MAIN_SCRIPT]?.script?.toString() ?? '',
                    },
                };
                break;
            }
            case ConnectorType.BRAINSTORM_MODE:
            case ConnectorType.HYPER_GRPC:
                console.warn(
                    `script query executor does not support connector ${state.connectorInfo.connectorType} yet`,
                );
                return;
        }

        // Accept the query and clear the request
        const initialState: QueryExecutionTaskState = {
            task,
            status: QueryExecutionStatus.ACCEPTED,
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
            try {
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
            } catch (e: any) {
                console.error(e);
            }
        };
        // Execute the query and consume the results
        const run = async () => {
            try {
                // Start the query
                let resultStream: QueryExecutionResponseStream | null = null;
                switch (task.type) {
                    case SALESFORCE_DATA_CLOUD_CONNECTOR: {
                        const req = task.value;
                        resultStream = req.api.executeQuery(req.scriptText, req.dataCloudAccessToken);
                        break;
                    }
                }
                if (resultStream != null) {
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
                }
            } catch (e: any) {
                if ((e.message === 'AbortError')) {
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
