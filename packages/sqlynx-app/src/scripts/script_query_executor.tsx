import * as React from 'react';
import Immutable from 'immutable';

import { useScriptState, useScriptStateDispatch } from '../scripts/script_state_provider';
import { SALESFORCE_DATA_CLOUD } from '../connectors/connector_info';
import {
    QueryExecutionResponseStream,
    QueryExecutionTaskState,
    QueryExecutionTaskStatus,
} from '../connectors/query_execution';
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

export const ScriptQueryExecutor = (props: { children?: React.ReactElement }) => {
    const state = useScriptState();
    const dispatch = useScriptStateDispatch();

    React.useEffect(() => {
        if (state.queryExecutionRequest == null) {
            return;
        }
        const request = state.queryExecutionRequest;

        // Accept the query and clear the request
        const initialState: QueryExecutionTaskState = {
            task: state.queryExecutionRequest,
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
                switch (request.type) {
                    case SALESFORCE_DATA_CLOUD: {
                        const api = request.value.api;
                        const script = request.value.scriptText;
                        const token = request.value.accessToken;
                        resultStream = api.executeQuery(script, token);
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
    }, [state.queryExecutionRequest]);

    return props.children;
};
