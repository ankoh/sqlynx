import { ConnectorInfo } from "../../connection/connector_info.js";
import { VariantKind } from "../../utils/variant.js";
import { ConnectionDetailsVariant, ConnectionState } from "../../connection/connection_state.js";
import { QueryExecutionState } from "../../connection/query_execution_state.js";

export const METRIC_REQUEST_COUNT = Symbol("METRIC_REQUEST_COUNT");
export const METRIC_LATEST_REQUEST_STARTED = Symbol("METRIC_LATEST_REQUEST_STARTED");

export type QueryStageMetricVariant =
    | VariantKind<typeof METRIC_REQUEST_COUNT, number>
    | VariantKind<typeof METRIC_LATEST_REQUEST_STARTED, Date>
    ;

export enum QueryStageType {
    PREPARE_QUERY,
    SEND_QUERY,
    AWAIT_FIRST_QUERY_RESULT,
    // Finished, failed or cancelled
    AWAIT_QUERY_END,
    PROCESS_QUERY_RESULTS,
}

export interface QueryStage {
    /// The stage type
    stageType: QueryStageType;
    /// The metrics
    stageMetrics: QueryStageMetricVariant[];
    /// Started at?
    startedAt: Date | null;
    /// Finished at?
    finishedAt: Date | null;
}

/// The view model for a query
export interface QueryInfoViewModel {
    /// The stages
    stages: QueryStage[];
    /// Finished at?
    error: Error | null;
    /// Failed at?
    wasCancelled: boolean;
}

/// The view model for a connection
export interface ConnectionViewModel {
    /// The connection info
    connectionInfo: ConnectorInfo;
    /// The connection details
    connectionDetails: ConnectionDetailsVariant;
    /// The queries that are either running or have been provided via props
    queriesRunning: QueryInfoViewModel[];
    /// The finished queries
    queriesFinished: QueryInfoViewModel[];
}

/// Helper to compute the view model for a connection entry
export function computeConnectionInfoViewModel(state: ConnectionState): ConnectionViewModel {
    let out: ConnectionViewModel = {
        connectionInfo: state.connectorInfo,
        connectionDetails: state.details,
        queriesRunning: [],
        queriesFinished: []
    };
    const queries: [Map<number, QueryExecutionState>, QueryInfoViewModel[]][] = [
        [state.queriesActive, out.queriesRunning],
        [state.queriesFinished, out.queriesFinished]
    ];
    for (const [i, o] of queries) {
        for (const [_queryId, query] of i) {
            const prepareQuery: QueryStage = {
                stageType: QueryStageType.PREPARE_QUERY,
                stageMetrics: [

                ],
                startedAt: query.metrics.queryQueuedAt,
                finishedAt: query.metrics.queryPreparedAt,
            };
            const sendQuery: QueryStage = {
                stageType: QueryStageType.SEND_QUERY,
                stageMetrics: [

                ],
                startedAt: query.metrics.queryPreparedAt,
                finishedAt: query.metrics.queryRunningAt,
            };
            const awaitFirstBatch: QueryStage = {
                stageType: QueryStageType.AWAIT_FIRST_QUERY_RESULT,
                stageMetrics: [

                ],
                startedAt: query.metrics.queryRunningAt,
                finishedAt: query.metrics.receivedFirstBatchAt,
            };
            const awaitQueryEnd: QueryStage = {
                stageType: QueryStageType.AWAIT_QUERY_END,
                stageMetrics: [

                ],
                startedAt: query.metrics.receivedFirstBatchAt,
                finishedAt: query.metrics.receivedLastBatchAt,
            };
            const processResults: QueryStage = {
                stageType: QueryStageType.PROCESS_QUERY_RESULTS,
                stageMetrics: [

                ],
                startedAt: query.metrics.receivedLastBatchAt,
                finishedAt: query.metrics.processedResultsAt,
            };
            o.push({
                stages: [
                    prepareQuery,
                    sendQuery,
                    awaitFirstBatch,
                    awaitQueryEnd,
                    processResults
                ],
                error: query.error,
                wasCancelled: query.cancellation.signal.aborted,
            })
        }
    }
    return out;
}
