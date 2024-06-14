import * as React from 'react';

import { useConnectionState, useDynamicConnectionDispatch } from './connection_registry.js';
import {
    QueryExecutionResponseStream,
    QueryExecutionStatus,
    QueryExecutionTaskState,
    QueryExecutionTaskVariant,
} from './query_execution_state.js';
import { useSalesforceAPI } from './salesforce_connector.js';
import { HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR } from './connector_info.js';
import {
    QUERY_EXECUTION_ACCEPTED,
    QUERY_EXECUTION_CANCELLED,
    QUERY_EXECUTION_FAILED,
    QUERY_EXECUTION_PROGRESS_UPDATED,
    QUERY_EXECUTION_RECEIVED_BATCH,
    QUERY_EXECUTION_RECEIVED_SCHEMA,
    QUERY_EXECUTION_STARTED,
    QUERY_EXECUTION_SUCCEEDED,
} from './connection_state.js';

let NEXT_QUERY_ID = 1;

/// The query executor args
interface QueryExecutionArgs {
    query: string;
}
/// The query executor function
export type QueryExecutor = (connectionId: number, args: QueryExecutionArgs) => [number, Promise<void>];
/// The React context to resolve the active query executor
const EXECUTOR_CTX = React.createContext<QueryExecutor | null>(null);
/// The hook to resolve the query executor
export const useQueryExecutor = () => React.useContext(EXECUTOR_CTX)!;
/// Use the query state
export function useQueryState(connectionId: number | null, queryId: number | null) {
    if (!connectionId || !queryId) return null;
    const [connReg, _connDispatch] = useConnectionState(connectionId);
    const queryState = connReg?.queriesFinished.get(queryId) ?? connReg?.queriesRunning.get(queryId);
    return queryState ?? null;
}

export function QueryExecutorProvider(props: { children?: React.ReactElement }) {
    const sfApi = useSalesforceAPI();

    // The connection registry changes frequently, the connection map is stable.
    // This executor will depend on the map directly since it can resolve everything ad-hoc.
    const [connReg, connDispatch] = useDynamicConnectionDispatch();
    const connMap = connReg.connectionMap;

    // Execute a query with pre-allocated query id
    const executeWithId = React.useCallback(async (connectionId: number, args: QueryExecutionArgs, queryId: number): Promise<void> => {
        // Check if we know the connection id.
        const conn = connMap.get(connectionId);
        if (!conn) {
            throw new Error(`couldn't find a connection with id ${connectionId}`);
        }

        // Build the query task
        let task: QueryExecutionTaskVariant;
        switch (conn.details.type) {
            case SALESFORCE_DATA_CLOUD_CONNECTOR: {
                const sfConn = conn.details.value;
                task = {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        api: sfApi,
                        authParams: sfConn.authParams!,
                        dataCloudAccessToken: sfConn.dataCloudAccessToken!,
                        scriptText: args.query,
                    },
                };
                break;
            }
            case HYPER_GRPC_CONNECTOR:
                // XXX
                return;
            case SERVERLESS_CONNECTOR:
                throw new Error(
                    `script query executor does not support connector ${conn.connectionInfo.connectorType} yet`,
                );
        }

        // Accept the query and clear the request
        const initialState: QueryExecutionTaskState = {
            queryId,
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
            resultBatches: [],
        };
        connDispatch(connectionId, {
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
                connDispatch(connectionId, {
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
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_RECEIVED_SCHEMA,
                    value: schema,
                });
                while (true) {
                    const batch = await resultStream.nextRecordBatch();
                    if (batch == null) {
                        break;
                    }
                    connDispatch(connectionId, {
                        type: QUERY_EXECUTION_RECEIVED_BATCH,
                        value: batch,
                    });
                }
            } catch (e: any) {
                console.error(e);
            }
        };
        // Execute the query and consume the results
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
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_STARTED,
                    value: resultStream,
                });
                // Subscribe to progress and result messages
                const progress = progressUpdater(resultStream);
                const results = resultReader(resultStream);
                await Promise.all([results, progress]);
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_SUCCEEDED,
                    value: null,
                });
            }
        } catch (e: any) {
            if ((e.message === 'AbortError')) {
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_CANCELLED,
                    value: null,
                });
            } else {
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_FAILED,
                    value: e,
                });
            }
            throw e;
        }
    }, [connMap, sfApi]);

    // Allocate the next query id and start the execution
    const execute = React.useCallback<QueryExecutor>((connectionId: number, args: QueryExecutionArgs): [number, Promise<void>] => {
        const queryId = NEXT_QUERY_ID++;
        const execution = executeWithId(connectionId, args, NEXT_QUERY_ID);
        return [queryId, execution];
    }, [executeWithId]);

    return (
        <EXECUTOR_CTX.Provider value={execute}>
            {props.children}
        </EXECUTOR_CTX.Provider>
    );
}
