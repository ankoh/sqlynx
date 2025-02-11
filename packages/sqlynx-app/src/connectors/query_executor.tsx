import * as arrow from 'apache-arrow';
import * as React from 'react';

import { useConnectionState, useDynamicConnectionDispatch } from './connection_registry.js';
import {
    QueryExecutionResponseStream,
    QueryExecutionState,
    QueryExecutionStatus,
} from './query_execution_state.js';
import { useSalesforceAPI } from './salesforce/salesforce_connector.js';
import { DEMO_CONNECTOR, HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
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
import { useComputationRegistry } from '../compute/computation_registry.js';
import { analyzeTable } from '../compute/computation_actions.js';
import { useSQLynxComputeWorker } from '../compute/compute_provider.js';
import { useLogger } from '../platform/logger_provider.js';
import { QueryExecutionArgs } from './query_execution_args.js';
import { executeTrinoQuery } from './trino/trino_query_execution.js';
import { executeSalesforceQuery } from './salesforce/salesforce_query_execution.js';
import { executeHyperQuery } from './hyper/hyper_query_execution.js';
import { executeDemoQuery } from './demo/demo_query_execution.js';

let NEXT_QUERY_ID = 1;
/// The query executor function
export type QueryExecutor = (connectionId: number, args: QueryExecutionArgs) => [number, Promise<arrow.Table | null>];
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
    const logger = useLogger();
    const sfApi = useSalesforceAPI();

    // The connection registry changes frequently, the connection map is stable.
    // This executor will depend on the map directly since it can resolve everything ad-hoc.
    const [connReg, connDispatch] = useDynamicConnectionDispatch();
    const connMap = connReg.connectionMap;

    // We auto-register each successfull query result with the sqlynx-compute worker
    const [_, computeDispatch] = useComputationRegistry();
    // Use the compute worker
    const computeWorker = useSQLynxComputeWorker();

    // Execute a query with pre-allocated query id
    const executeImpl = React.useCallback(async (connectionId: number, args: QueryExecutionArgs, queryId: number): Promise<arrow.Table | null> => {
        // Make sure the compute worker is available
        if (!computeWorker) {
            throw new Error(`compute worker is not yet ready`);
        }
        // Check if we know the connection id.
        const conn = connMap.get(connectionId);
        if (!conn) {
            throw new Error(`couldn't find a connection with id ${connectionId}`);
        }

        // Accept the query and clear the request
        const initialState: QueryExecutionState = {
            queryId,
            status: QueryExecutionStatus.ACCEPTED,
            cancellation: new AbortController(),
            resultStream: null,
            error: null,
            metrics: {
                startedAt: null,
                finishedAt: null,
                lastUpdatedAt: null,
                dataBytesReceived: 0,
                batchesReceived: 0,
                rowsReceived: 0,
                progressUpdatesReceived: 0,
                durationUntilSchemaMs: null,
                durationUntilFirstBatchMs: null,
                queryDurationMs: null,
            },
            latestProgressUpdate: null,
            resultMetadata: null,
            resultSchema: null,
            resultBatches: [],
            resultTable: null,
        };
        connDispatch(connectionId, {
            type: EXECUTE_QUERY,
            value: [queryId, initialState],
        });

        // Helper to subscribe to query_status updates
        const readAllProgressUpdates = async (resultStream: QueryExecutionResponseStream) => {
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
            return null;
        };
        // Helper to subscribe to result batches
        const readAllBatches = async (resultStream: QueryExecutionResponseStream) => {
            const schema = await resultStream.getSchema();
            if (schema == null) {
                return;
            }
            connDispatch(connectionId, {
                type: QUERY_EXECUTION_RECEIVED_SCHEMA,
                value: [queryId, schema],
            });
            const batches: arrow.RecordBatch[] = [];
            while (true) {
                const batch = await resultStream.nextRecordBatch();
                if (batch == null) {
                    break;
                }
                batches.push(batch);
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_RECEIVED_BATCH,
                    value: [queryId, batch, resultStream.getMetrics()],
                });
            }
            return new arrow.Table(schema, batches);
        };
        // Execute the query and consume the results
        let resultStream: QueryExecutionResponseStream | null = null;
        let table: arrow.Table | null = null;
        try {
            // Start the query
            switch (conn.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    resultStream = await executeSalesforceQuery(conn.details.value, args);
                    break;
                case HYPER_GRPC_CONNECTOR:
                    resultStream = await executeHyperQuery(conn.details.value, args);
                    break;
                case TRINO_CONNECTOR:
                    resultStream = await executeTrinoQuery(conn.details.value, args);
                    break;
                case DEMO_CONNECTOR:
                    resultStream = await executeDemoQuery(conn.details.value, args);
                    break;
            }
            if (resultStream != null) {
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_STARTED,
                    value: [queryId, resultStream],
                });
                // Subscribe to query_status and result messages
                const progressUpdater = readAllProgressUpdates(resultStream);
                const tableReader = readAllBatches(resultStream);
                const result = await Promise.all([tableReader, progressUpdater]);
                table = result[0]!;

                // Is there any metadata?
                const metadata = resultStream.getMetadata();
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_SUCCEEDED,
                    value: [queryId, table!, metadata, resultStream!.getMetrics()],
                });
            }
        } catch (e: any) {
            if ((e.message === 'AbortError')) {
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_CANCELLED,
                    value: [queryId, e, resultStream?.getMetrics() ?? null],
                });
            } else {
                console.error(e);
                connDispatch(connectionId, {
                    type: QUERY_EXECUTION_FAILED,
                    value: [queryId, e, resultStream?.getMetrics() ?? null],
                });
            }
        }


        // Compute all table summaries of the result
        if (table && args.analyzeResults) {
            analyzeTable(queryId, table!, computeDispatch, computeWorker, logger);
        }

        return table;

    }, [connMap, sfApi]);

    // Allocate the next query id and start the execution
    const execute = React.useCallback<QueryExecutor>((connectionId: number, args: QueryExecutionArgs): [number, Promise<arrow.Table | null>] => {
        const queryId = NEXT_QUERY_ID++;
        const execution = executeImpl(connectionId, args, queryId);
        return [queryId, execution];
    }, [executeImpl]);

    return (
        <EXECUTOR_CTX.Provider value={execute}>
            {props.children}
        </EXECUTOR_CTX.Provider>
    );
}
