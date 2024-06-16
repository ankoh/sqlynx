import * as React from 'react';
import * as proto from '@ankoh/sqlynx-pb';

import { useConnectionState, useDynamicConnectionDispatch } from './connection_registry.js';
import {
    QueryExecutionResponseStream,
    QueryExecutionState,
    QueryExecutionStatus,
    QueryExecutionTaskVariant,
} from './query_execution_state.js';
import { useSalesforceAPI } from './salesforce_connector.js';
import { HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR } from './connector_info.js';
import {
    EXECUTE_QUERY,
    QUERY_EXECUTION_CANCELLED,
    QUERY_EXECUTION_FAILED,
    QUERY_EXECUTION_PROGRESS_UPDATED,
    QUERY_EXECUTION_RECEIVED_BATCH,
    QUERY_EXECUTION_RECEIVED_SCHEMA,
    QUERY_EXECUTION_STARTED,
    QUERY_EXECUTION_SUCCEEDED,
} from './connection_state.js';
import { GrpcError } from '../platform/grpc_common.js';

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
    const [connReg, _connDispatch] = useConnectionState(connectionId);
    if (queryId == null) return null;
    return connReg?.queriesRunning.get(queryId) ?? connReg?.queriesFinished.get(queryId) ?? null;
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
                const c = conn.details.value;
                task = {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        api: sfApi,
                        dataCloudAccessToken: c.dataCloudAccessToken!,
                        scriptText: args.query,
                    },
                };
                break;
            }
            case HYPER_GRPC_CONNECTOR: {
                const c = conn.details.value;
                const channel = c.channel;
                if (!channel) {
                    throw new Error(`hyper channel is not set up`);
                }
                task = {
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        hyperChannel: channel,
                        scriptText: args.query,
                    }
                }
                break;
            }
            case SERVERLESS_CONNECTOR:
                throw new Error(
                    `script query executor does not support connector ${conn.connectionInfo.connectorType} yet`,
                );
        }

        // Accept the query and clear the request
        const initialState: QueryExecutionState = {
            queryId,
            task: task,
            status: QueryExecutionStatus.ACCEPTED,
            cancellation: new AbortController(),
            resultStream: null,
            error: null,
            metrics: {
                startedAt: null,
                finishedAt: null,
                lastUpdatedAt: null,
                batchesReceived: 0,
                rowsReceived: 0,
                progressUpdatesReceived: 0,
                durationUntilSchemaMs: null,
                durationUntilFirstBatchMs: null,
                queryDurationMs: null,
            },
            latestProgressUpdate: null,
            resultSchema: null,
            resultBatches: [],
            resultTable: null,
        };
        connDispatch(connectionId, {
            type: EXECUTE_QUERY,
            value: [queryId, initialState],
        });

        // Helper to subscribe to query_status updates
        const progressUpdater = async (resultStream: QueryExecutionResponseStream) => {
            while (true) {
                const update = await resultStream.nextProgressUpdate();
                if (update == null) {
                    break;
                }
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_PROGRESS_UPDATED,
                    value: [queryId, update],
                });
            }
        };
        // Helper to subscribe to result batches
        const resultReader = async (resultStream: QueryExecutionResponseStream) => {
            const schema = await resultStream.getSchema();
            if (schema == null) {
                return;
            }
            connDispatch(connectionId, {
                type: QUERY_EXECUTION_RECEIVED_SCHEMA,
                value: [queryId, schema],
            });
            while (true) {
                const batch = await resultStream.nextRecordBatch();
                if (batch == null) {
                    break;
                }
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_RECEIVED_BATCH,
                    value: [queryId, batch],
                });
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
                case HYPER_GRPC_CONNECTOR: {
                    const req = task.value;
                    const param = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
                        query: req.scriptText
                    });
                    resultStream = await req.hyperChannel.executeQuery(param);
                }
            }
            if (resultStream != null) {
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_STARTED,
                    value: [queryId, resultStream],
                });
                // Subscribe to query_status and result messages
                const progress = progressUpdater(resultStream);
                const results = resultReader(resultStream);
                await Promise.all([results, progress]);
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_SUCCEEDED,
                    value: [queryId, null],
                });
            }
        } catch (e: any) {
            if ((e.message === 'AbortError')) {
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_CANCELLED,
                    value: [queryId, e],
                });
            } else {
                console.error(e);
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_FAILED,
                    value: [queryId, e],
                });
            }
        }
    }, [connMap, sfApi]);

    // Allocate the next query id and start the execution
    const execute = React.useCallback<QueryExecutor>((connectionId: number, args: QueryExecutionArgs): [number, Promise<void>] => {
        const queryId = NEXT_QUERY_ID++;
        const execution = executeWithId(connectionId, args, queryId);
        return [queryId, execution];
    }, [executeWithId]);

    return (
        <EXECUTOR_CTX.Provider value={execute}>
            {props.children}
        </EXECUTOR_CTX.Provider>
    );
}
