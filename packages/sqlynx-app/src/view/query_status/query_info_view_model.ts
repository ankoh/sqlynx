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
    REQUEST_QUERY,
    PREPARE_QUERY,
    SEND_QUERY,
    QUEUE_QUERY,
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
            const registerQuery: QueryStage = {
                stageType: QueryStageType.REQUEST_QUERY,
                stageMetrics: [],
                startedAt: query.metrics.queryRequestedAt,
            };
            const prepareQuery: QueryStage = {
                stageType: QueryStageType.PREPARE_QUERY,
                stageMetrics: [],
                startedAt: query.metrics.queryPreparingStartedAt,
            };
            const sendQuery: QueryStage = {
                stageType: QueryStageType.SEND_QUERY,
                stageMetrics: [],
                startedAt: query.metrics.queryPreparingStartedAt,
            };
            const queueQuery: QueryStage = {
                stageType: QueryStageType.QUEUE_QUERY,
                stageMetrics: [],
                startedAt: query.metrics.queryQueuedStartedAt,
            };
            const awaitFirstBatch: QueryStage = {
                stageType: QueryStageType.AWAIT_FIRST_QUERY_RESULT,
                stageMetrics: [],
                startedAt: query.metrics.queryRunningStartedAt,
            };
            const awaitQueryEnd: QueryStage = {
                stageType: QueryStageType.AWAIT_QUERY_END,
                stageMetrics: [],
                startedAt: query.metrics.receivedFirstBatchAt,
            };
            const processResults: QueryStage = {
                stageType: QueryStageType.PROCESS_QUERY_RESULTS,
                stageMetrics: [],
                startedAt: query.metrics.receivedLastBatchAt,
            };
            o.push({
                stages: [
                    registerQuery,
                    prepareQuery,
                    sendQuery,
                    queueQuery,
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
